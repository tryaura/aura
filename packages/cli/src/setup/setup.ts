import type { Writable } from "node:stream";

import type { Environment } from "@tryaura/aura-sdk";
import {
  applyFixPlan,
  buildWorkspaceModel,
  prepareFixPlan,
  runChecks,
  type FixPlanPreview,
  type PluginRegistry,
  type WorkspaceScan,
} from "@tryaura/core";

import { createCheckReport } from "../report.js";
import { renderHuman, safe } from "../render.js";
import type { CliBranding, CliExitCode } from "../types.js";
import { buildAppCatalog } from "./catalog.js";
import { planSetup, type SetupNotice } from "./planner.js";
import { createSnippetCatalog } from "./snippets.js";
import { SETUP_STEPS } from "./steps/index.js";
import { renderSetupSummary } from "./summary.js";
import {
  SETUP_ABORTED,
  type SetupSelections,
  type SetupStep,
  type SetupStepContext,
} from "./types.js";
import type { WizardIo } from "./wizard-types.js";

/** Everything one `setup` run needs, so the flow does not reach back into the command object. */
export interface SetupRequest {
  readonly branding: CliBranding;
  readonly dryRun: boolean;
  readonly environment: Environment;
  readonly io: WizardIo;
  readonly registry: PluginRegistry;
  /** Home captured before `--home`, used for locks shared by every run from this process boundary. */
  readonly stateHomeDir: string;
  readonly stderr: Writable;
  readonly stdout: Writable;
  /** Overrides the registered steps; tests exercise multi-step flows through this. */
  readonly steps?: readonly SetupStep[] | undefined;
  /** Whether the summary may quote the contents of the files it rewrites. */
  readonly withDetail: boolean;
}

/**
 * The `setup` flow: scan, gather selections, plan, confirm once, apply, end on green.
 *
 * Steps never write and the plan applies through the fix-plan kernel after one confirmation, so
 * backing out anywhere before that leaves the filesystem untouched by construction. A machine that
 * already matches the desired state previews as all-noop and skips both the confirmation and the
 * journal — the fifth run is the first run.
 */
export async function runSetup(request: SetupRequest): Promise<CliExitCode> {
  const { branding, environment, io, stdout } = request;
  stdout.write(`${branding.displayName} setup\n\n`);

  const scan = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment,
    snippets: request.registry.snippets,
  });
  const model = scan.model;

  if (model.manifest.status === "read-only") {
    request.stderr.write(`${branding.displayName}: ${safe(model.manifest.problem.message)}\n`);
    return 2;
  }

  // After the early return, because the steps are the only reason findings are needed here and the
  // duplicate scan is quadratic in the paragraphs it compares.
  const initialChecks = runChecks(request.registry.checks, model);
  for (const diagnostic of initialChecks.diagnostics) {
    // Message only, never `detail`: it is verbatim text from a check that read the user's files.
    io.note(
      `${diagnostic.checkId} could not run, so its findings are missing: ${diagnostic.message}`,
    );
  }

  const appCatalog = buildAppCatalog(request.registry.adapters, model);
  const snippetCatalog = createSnippetCatalog(request.registry.snippets, model.manifest);

  const gathered = await gatherSelections(
    request.steps ?? SETUP_STEPS,
    {
      appCatalog,
      findings: initialChecks.findings,
      manifest: model.manifest,
      model,
      snippetCatalog,
    },
    io,
  );
  if (gathered.status === "invalid-dependency") {
    request.stderr.write(
      `${branding.displayName}: setup step "${safe(gathered.stepId)}" requires "${safe(gathered.dependencyId)}" to run first. Run the full setup flow.\n`,
    );
    return 2;
  }
  if (gathered.status === "aborted") {
    stdout.write("\nLeft everything as it was.\n");
    return 1;
  }
  const selections = gathered.selections;

  const outcome = planSetup({
    appCatalog,
    findings: initialChecks.findings,
    manifest: model.manifest,
    model,
    selections,
    snippetCatalog,
  });
  const prepared = await prepareFixPlan({ model, plan: outcome.plan });

  if (
    prepared.preview.changedOperationCount === 0 &&
    prepared.preview.conflictedOperationCount === 0 &&
    outcome.blockers.length === 0
  ) {
    renderConvergedSetup(prepared.preview, outcome.notices, request.withDetail, stdout);
    return endOnGreen(request, scan);
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
      `${branding.displayName}: the plan is blocked by the current state of these files; nothing was changed.\n`,
    );
    return 2;
  }

  if (request.dryRun) {
    stdout.write("\nDry run: nothing was written.\n");
    return 0;
  }

  const confirmation = await io.confirm("Apply this plan?");
  if (confirmation === "aborted") {
    stdout.write("\nLeft everything as it was.\n");
    return 1;
  }
  if (confirmation === "declined") {
    stdout.write("\nLeft everything as it was.\n");
    return 0;
  }

  const result = await applyFixPlan(prepared, {
    now: environment.now,
    stateHomeDir: request.stateHomeDir,
  });
  stdout.write(`\nApplied ${String(result.appliedOperationCount)} operation(s).\n`);
  if (result.backupId !== undefined) {
    stdout.write(`The previous contents are saved as backup ${safe(result.backupId)}.\n`);
  }
  stdout.write("\n");

  // End on green: rescan so the checklist reports what is now on disk, not what was planned.
  const rescanned = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment,
    snippets: request.registry.snippets,
  });
  return endOnGreen(request, rescanned);
}

type GatherSelectionsResult =
  | { readonly status: "aborted" }
  | {
      readonly dependencyId: string;
      readonly status: "invalid-dependency";
      readonly stepId: string;
    }
  | { readonly selections: SetupSelections; readonly status: "ready" };

async function gatherSelections(
  steps: readonly SetupStep[],
  context: Omit<SetupStepContext, "selections">,
  io: WizardIo,
): Promise<GatherSelectionsResult> {
  let selections: SetupSelections = {};
  const completedSteps = new Set<string>();
  for (const step of steps) {
    const dependencyId = step.dependsOn?.find((id) => !completedSteps.has(id));
    if (dependencyId !== undefined) {
      return { dependencyId, status: "invalid-dependency", stepId: step.id };
    }
    const outcome = await step.gather({ ...context, selections }, io);
    if (outcome === SETUP_ABORTED) {
      return { status: "aborted" };
    }
    selections = outcome;
    completedSteps.add(step.id);
  }
  return { selections, status: "ready" };
}

function renderConvergedSetup(
  preview: FixPlanPreview,
  notices: readonly SetupNotice[],
  withDetail: boolean,
  output: Writable,
): void {
  output.write("\n");
  if (preview.manualSteps.length === 0 && notices.length === 0) {
    output.write("Already converged — nothing to change.\n\n");
    return;
  }
  renderSetupSummary(preview, [], notices, withDetail, output);
  output.write("\n");
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
    withDetail: request.withDetail,
  });
  renderHuman(report, request.branding, request.stdout);
  return report.summary.exitCode;
}
