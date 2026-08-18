import type { Writable } from "node:stream";

import type { AuraManifest, Environment, SetupRunOutcome } from "@tryaura/aura-sdk";
import {
  applyFixPlan,
  buildWorkspaceModel,
  prepareFixPlan,
  type PluginRegistry,
  type WorkspaceScan,
} from "@tryaura/core";
import { pluralize } from "@tryaura/core/pluralize";

import { safe } from "../safe-text.js";
import { elapsedMs, setupRunEvent } from "../telemetry-events.js";
import type { TelemetryRecorder } from "../telemetry.js";
import type { CliBranding, CliExitCode } from "../types.js";
import { buildAppCatalog } from "./catalog.js";
import { createSetupCatalogs } from "./catalogs.js";
import { endOnGreen, gatherFindings } from "./green.js";
import { planSetup } from "./planner.js";
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
  /** False when `io` answers for the user, which the MCP step reads before proposing a default. */
  readonly interactive: boolean;
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
  /** The run's telemetry recorder. A no-op unless the distribution composed a sink. */
  readonly telemetry: TelemetryRecorder;
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
  const startedAt = environment.now();
  // The one telemetry funnel: every return below passes through it, so a run emits exactly once.
  const finish = (
    exitCode: CliExitCode,
    outcome: SetupRunOutcome,
    extras?: {
      readonly appliedOperationCount?: number | undefined;
      readonly manifest?: AuraManifest | undefined;
    },
  ): CliExitCode => {
    request.telemetry.record(
      setupRunEvent({
        appliedOperationCount: extras?.appliedOperationCount,
        durationMs: elapsedMs(environment, startedAt),
        exitCode,
        manifest: extras?.manifest,
        outcome,
      }),
    );
    return exitCode;
  };
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
    return finish(2, "unusable");
  }

  const steps = request.steps ?? SETUP_STEPS;
  // After the early return, and only when a selected step reads them: the duplicate scan among the
  // checks is quadratic in the paragraphs it compares, and `endOnGreen` runs its own pass anyway.
  const initialFindings = steps.some((step) => step.needsFindings === true)
    ? gatherFindings(request.registry.checks, model, io)
    : undefined;

  const catalogs = await createSetupCatalogs({
    environment,
    model,
    registry: request.registry,
    steps,
  });
  if (catalogs.kind === "invalid-preset") {
    for (const message of catalogs.messages) {
      request.stderr.write(`${branding.displayName}: ${safe(message)}\n`);
    }
    return finish(2, "unusable");
  }

  const stepContext = {
    appCatalog: buildAppCatalog(request.registry.adapters, model, scan.skipped),
    ...(initialFindings === undefined ? {} : { findings: initialFindings }),
    interactive: request.interactive,
    isEnvironmentVariableSet: (name: string) => environment.readVariable(name) !== undefined,
    manifest: model.manifest,
    mcpCatalog: catalogs.mcpCatalog,
    model,
    skillCatalog: catalogs.skillCatalog,
    snippetCatalog: createSnippetCatalog(request.registry.snippets, model.manifest),
  };

  // The confirmation can send the user ← back into the last step, so gather → plan → confirm
  // repeats until the plan is accepted, declined, or aborted. Nothing is written inside the loop.
  let start: GatherStart = { index: 0, selections: {} };
  let ready: { readonly manifest: AuraManifest; readonly prepared: PreparedPlan };
  for (;;) {
    const pass = await runPass(request, steps, stepContext, scan, start);
    if (pass.kind === "back") {
      start = pass.start;
      continue;
    }
    if (pass.kind === "exit") {
      return finish(pass.code, pass.outcome, { manifest: pass.manifest });
    }
    ready = pass;
    break;
  }

  const result = await applyFixPlan(ready.prepared, {
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
  return finish(endOnGreen(request, rescanned), "applied", {
    appliedOperationCount: result.appliedOperationCount,
    manifest: ready.manifest,
  });
}

type PreparedPlan = Awaited<ReturnType<typeof prepareFixPlan>>;

type PlanOutcome =
  | { readonly kind: "blocked"; readonly manifest: AuraManifest }
  | { readonly kind: "converged"; readonly manifest: AuraManifest }
  | { readonly kind: "ready"; readonly manifest: AuraManifest; readonly prepared: PreparedPlan };

type PassOutcome =
  | {
      readonly kind: "apply";
      readonly manifest: AuraManifest;
      readonly prepared: PreparedPlan;
    }
  | { readonly kind: "back"; readonly start: GatherStart }
  | {
      readonly code: CliExitCode;
      readonly kind: "exit";
      /** Present whenever the pass produced a plan, so popularity data survives a non-write exit. */
      readonly manifest?: AuraManifest | undefined;
      readonly outcome: SetupRunOutcome;
    };

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
    return { code: 2, kind: "exit", outcome: "unusable" };
  }
  if (gathered.status === "aborted") {
    stdout.write("\nLeft everything as it was.\n");
    return { code: 1, kind: "exit", outcome: "aborted" };
  }
  const selections = gathered.selections;

  const planned = await previewPlan(request, { ...stepContext, selections });
  if (planned.kind === "converged") {
    return {
      code: endOnGreen(request, scan),
      kind: "exit",
      manifest: planned.manifest,
      outcome: "converged",
    };
  }
  if (planned.kind === "blocked") {
    return { code: 2, kind: "exit", manifest: planned.manifest, outcome: "blocked" };
  }
  if (request.dryRun) {
    stdout.write("\nDry run: nothing was written.\n");
    return { code: 0, kind: "exit", manifest: planned.manifest, outcome: "dry-run" };
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
    return confirmation === "aborted"
      ? { code: 1, kind: "exit", manifest: planned.manifest, outcome: "aborted" }
      : { code: 0, kind: "exit", manifest: planned.manifest, outcome: "declined" };
  }
  return { kind: "apply", manifest: planned.manifest, prepared: planned.prepared };
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
    return { kind: "converged", manifest: outcome.manifest };
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
    return { kind: "blocked", manifest: outcome.manifest };
  }
  return { kind: "ready", manifest: outcome.manifest, prepared };
}
