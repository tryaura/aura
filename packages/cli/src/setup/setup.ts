import type { Writable } from "node:stream";

import type { Environment, Finding } from "@tryaura/aura-sdk";
import {
  applyFixPlan,
  buildWorkspaceModel,
  createFileReader,
  prepareFixPlan,
  readTeamPreset,
  runChecks,
  type PluginRegistry,
  type TeamPresetState,
  type WorkspaceScan,
} from "@tryaura/core";
import { pluralize } from "@tryaura/core/pluralize";

import { createCheckReport } from "../report.js";
import { renderHuman } from "../render.js";
import { safe } from "../safe-text.js";
import type { CliBranding, CliExitCode } from "../types.js";
import { buildAppCatalog } from "./catalog.js";
import { planSetup } from "./planner.js";
import { createSkillCatalog } from "./skills-catalog.js";
import { createSnippetCatalog } from "./snippets.js";
import { SETUP_STEPS } from "./steps/index.js";
import { renderConvergedSetup, renderSetupSummary } from "./summary.js";
import { gatherSelections, toFlowStep, type GatherStart } from "./gather.js";
import type { SetupStep, SetupStepContext } from "./types.js";
import type { WizardIo } from "./wizard-types.js";

/** Everything one `setup` run needs, so the flow does not reach back into the command object. */
export interface SetupRequest {
  readonly branding: CliBranding;
  /** How much color the closing report may use. */
  readonly colorDepth: number;
  readonly dryRun: boolean;
  readonly environment: Environment;
  readonly io: WizardIo;
  readonly registry: PluginRegistry;
  /** Home captured before `--home`, used for locks shared by every run from this process boundary. */
  readonly stateHomeDir: string;
  readonly stderr: Writable;
  readonly stdout: Writable;
  /**
   * The steps this run gathers, defaulting to every registered one.
   *
   * `setup --add <kind>` narrows it to a single step through {@link selectSetupSteps}; tests use the
   * same seam to exercise one step in isolation.
   */
  readonly steps?: readonly SetupStep[] | undefined;
  /** Whether the summary may quote the contents of the files it rewrites. */
  readonly withDetail: boolean;
}

/**
 * The `setup` flow: scan, gather selections, plan, confirm once, apply, end on green.
 *
 * Steps never write and the plan applies through the fix-plan kernel after one confirmation, so
 * backing out anywhere before that leaves the filesystem untouched by construction. A machine that
 * already matches the desired state produces an empty operation plan and skips both confirmation
 * and the journal — the fifth run is the first run.
 */
export async function runSetup(request: SetupRequest): Promise<CliExitCode> {
  const { branding, environment, io, stdout } = request;
  stdout.write(`${branding.displayName} setup\n\n`);

  const scan = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment,
    mcpCatalog: request.registry.mcpServers,
    snippets: request.registry.snippets,
    skills: request.registry.skills,
  });
  const model = scan.model;

  if (model.manifest.status === "read-only") {
    request.stderr.write(`${branding.displayName}: ${safe(model.manifest.problem.message)}\n`);
    return 2;
  }

  const steps = request.steps ?? SETUP_STEPS;
  // After the early return, and only when a selected step reads them: the duplicate scan among the
  // checks is quadratic in the paragraphs it compares, and `endOnGreen` runs its own pass anyway.
  const initialFindings = steps.some((step) => step.needsFindings === true)
    ? gatherFindings(request, model, io)
    : undefined;

  const appCatalog = buildAppCatalog(request.registry.adapters, model, scan.skipped);
  const snippetCatalog = createSnippetCatalog(request.registry.snippets, model.manifest);
  const presetState: TeamPresetState = await readTeamPreset(environment.cwd, createFileReader());
  if (presetState.status === "invalid" && steps.some((step) => step.id === "skills")) {
    for (const diagnostic of presetState.diagnostics) {
      request.stderr.write(`${branding.displayName}: ${safe(diagnostic.message)}\n`);
    }
    return 2;
  }
  const skillCatalog = createSkillCatalog({
    environment,
    model,
    preset: presetState.preset,
    presetNotes: presetState.diagnostics.map((diagnostic) => diagnostic.message),
    registryDirectories: request.registry.skillDirectories,
  });

  const stepContext = {
    appCatalog,
    ...(initialFindings === undefined ? {} : { findings: initialFindings }),
    manifest: model.manifest,
    model,
    skillCatalog,
    snippetCatalog,
  };

  // The confirmation can send the user ← back into the last step, so gather → plan → confirm
  // repeats until the plan is accepted, declined, or aborted. Nothing is written inside the loop.
  let start: GatherStart = { index: 0, selections: {} };
  let prepared: PreparedPlan;
  for (;;) {
    const pass = await runPass(request, steps, stepContext, scan, start);
    if (pass.kind === "back") {
      start = pass.start;
      continue;
    }
    if (pass.kind === "exit") {
      return pass.code;
    }
    prepared = pass.prepared;
    break;
  }

  const result = await applyFixPlan(prepared, {
    now: environment.now,
    stateHomeDir: request.stateHomeDir,
  });
  stdout.write(
    `\nApplied ${String(result.appliedOperationCount)} ${pluralize(result.appliedOperationCount, "operation")}.\n`,
  );
  if (result.backupId !== undefined) {
    stdout.write(
      `The previous contents are saved as backup ${safe(result.backupId)}. Run ${branding.command} undo to restore them.\n`,
    );
  }
  stdout.write("\n");

  // End on green: rescan so the checklist reports what is now on disk, not what was planned.
  const rescanned = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment,
    mcpCatalog: request.registry.mcpServers,
    snippets: request.registry.snippets,
    skills: request.registry.skills,
  });
  return endOnGreen(request, rescanned);
}

/** Runs the checks whose findings a step asked for, reporting the ones that could not run. */
function gatherFindings(
  request: SetupRequest,
  model: WorkspaceScan["model"],
  io: WizardIo,
): readonly Finding[] {
  const run = runChecks(request.registry.checks, model);
  for (const diagnostic of run.diagnostics) {
    // Message only, never `detail`: it is verbatim text from a check that read the user's files.
    io.note(
      `${diagnostic.checkId} could not run, so its findings are missing: ${diagnostic.message}`,
    );
  }
  return run.findings;
}

type PreparedPlan = Awaited<ReturnType<typeof prepareFixPlan>>;

type PlanOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "converged" }
  | { readonly kind: "ready"; readonly prepared: PreparedPlan };

type PassOutcome =
  | { readonly kind: "apply"; readonly prepared: PreparedPlan }
  | { readonly kind: "back"; readonly start: GatherStart }
  | { readonly code: CliExitCode; readonly kind: "exit" };

/** One gather → plan → confirm pass; a confirmation backing out restarts at the last step. */
async function runPass(
  request: SetupRequest,
  steps: readonly SetupStep[],
  stepContext: Omit<SetupStepContext, "selections">,
  scan: WorkspaceScan,
  start: GatherStart,
): Promise<PassOutcome> {
  const { branding, io, stdout } = request;
  const gathered = await gatherSelections(steps, stepContext, io, start);
  if (gathered.status === "invalid-dependency") {
    request.stderr.write(
      `${branding.displayName}: the ${safe(gathered.stepTitle)} step needs ${safe(gathered.missing)}. Run ${branding.command} setup to establish it, then retry this command.\n`,
    );
    return { code: 2, kind: "exit" };
  }
  if (gathered.status === "aborted") {
    stdout.write("\nLeft everything as it was.\n");
    return { code: 1, kind: "exit" };
  }
  const selections = gathered.selections;

  const planned = await previewPlan(request, { ...stepContext, selections });
  if (planned.kind === "converged") {
    return { code: endOnGreen(request, scan), kind: "exit" };
  }
  if (planned.kind === "blocked") {
    return { code: 2, kind: "exit" };
  }
  if (request.dryRun) {
    stdout.write("\nDry run: nothing was written.\n");
    return { code: 0, kind: "exit" };
  }

  // The confirmation is the flow's Submit: every step is gathered, so the bar shows them done.
  const confirmation = await io.confirm("Apply this plan?", {
    completed: steps.map(toFlowStep),
    submit: true,
    upcoming: [],
  });
  if (confirmation === "back") {
    return {
      kind: "back",
      start: { entered: "backward", index: Math.max(0, steps.length - 1), selections },
    };
  }
  if (confirmation !== "accepted") {
    stdout.write("\nLeft everything as it was.\n");
    return { code: confirmation === "aborted" ? 1 : 0, kind: "exit" };
  }
  return { kind: "apply", prepared: planned.prepared };
}

/** Plans the gathered selections, renders the summary, and classifies what can happen next. */
async function previewPlan(
  request: SetupRequest,
  inputs: Parameters<typeof planSetup>[0],
): Promise<PlanOutcome> {
  const { stdout } = request;
  const outcome = planSetup(inputs);
  const prepared = await prepareFixPlan({ model: inputs.model, plan: outcome.plan });

  if (
    prepared.preview.changedOperationCount === 0 &&
    prepared.preview.conflictedOperationCount === 0 &&
    outcome.blockers.length === 0
  ) {
    renderConvergedSetup(prepared.preview, outcome.notices, request.withDetail, stdout);
    return { kind: "converged" };
  }

  stdout.write("\n");
  renderSetupSummary(
    prepared.preview,
    outcome.blockers,
    outcome.notices,
    request.withDetail,
    stdout,
  );

  if (prepared.preview.conflictedOperationCount > 0 || outcome.blockers.length > 0) {
    request.stderr.write(
      `${request.branding.displayName}: the plan is blocked by the current state of these files; nothing was changed.\n`,
    );
    return { kind: "blocked" };
  }
  return { kind: "ready", prepared };
}

function endOnGreen(request: SetupRequest, scan: WorkspaceScan): CliExitCode {
  const run = runChecks(request.registry.checks, scan.model);
  const report = createCheckReport({
    adapters: request.registry.adapters,
    apps: scan.model.apps,
    checkDiagnostics: run.diagnostics,
    checks: request.registry.checks,
    findings: run.findings,
    scanDiagnostics: scan.diagnostics,
    skipped: scan.skipped,
    withDetail: request.withDetail,
  });
  renderHuman(report, request.branding, request.stdout, request.colorDepth);
  return report.summary.exitCode;
}
