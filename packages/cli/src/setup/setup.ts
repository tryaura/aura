import type { Writable } from "node:stream";

import type { Environment } from "@tryaura/aura-sdk";
import {
  applyFixPlan,
  buildWorkspaceModel,
  prepareFixPlan,
  runChecks,
  type PluginRegistry,
  type WorkspaceScan,
} from "@tryaura/core";

import { createCheckReport } from "../report.js";
import { renderHuman, safe } from "../render.js";
import type { CliBranding, CliExitCode } from "../types.js";
import { buildAppCatalog } from "./catalog.js";
import { planSetup } from "./planner.js";
import { SETUP_STEPS } from "./steps/index.js";
import { renderSetupSummary } from "./summary.js";
import { SETUP_ABORTED, type SetupSelections, type SetupStep } from "./types.js";
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
  });
  const model = scan.model;

  if (model.manifest.status === "read-only") {
    request.stderr.write(`${branding.displayName}: ${safe(model.manifest.problem.message)}\n`);
    return 2;
  }

  const appCatalog = buildAppCatalog(request.registry.adapters, model);

  let selections: SetupSelections = {};
  for (const step of request.steps ?? SETUP_STEPS) {
    const outcome = await step.gather(
      { appCatalog, manifest: model.manifest, model, selections },
      io,
    );
    if (outcome === SETUP_ABORTED) {
      stdout.write("\nLeft everything as it was.\n");
      return 1;
    }
    selections = outcome;
  }

  const outcome = planSetup({ appCatalog, manifest: model.manifest, model, selections });
  const prepared = await prepareFixPlan({ model, plan: outcome.plan });

  if (
    prepared.preview.changedOperationCount === 0 &&
    prepared.preview.conflictedOperationCount === 0 &&
    outcome.blockers.length === 0
  ) {
    stdout.write("\nAlready converged — nothing to change.\n\n");
    return endOnGreen(request, scan);
  }

  stdout.write("\n");
  renderSetupSummary(prepared.preview, outcome.blockers, request.withDetail, stdout);

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
  });
  return endOnGreen(request, rescanned);
}

function endOnGreen(request: SetupRequest, scan: WorkspaceScan): CliExitCode {
  const run = runChecks(request.registry.checks, scan.model);
  const report = createCheckReport({
    checkDiagnostics: run.diagnostics,
    checks: request.registry.checks,
    findings: run.findings,
    scanDiagnostics: scan.diagnostics,
    skipped: scan.skipped,
    withDetail: request.withDetail,
  });
  renderHuman(report, request.branding, request.stdout);
  return report.exitCode;
}
