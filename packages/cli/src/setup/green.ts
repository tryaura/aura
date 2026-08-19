import type { Writable } from "node:stream";

import type { AuraEffectiveConfig, Check, Environment, Finding } from "@tryaura/aura-sdk";
import { runChecks, type PluginRegistry, type WorkspaceScan } from "@tryaura/core";

import { createCheckReport } from "../report.js";
import { renderHumanCheckReport } from "../render-human.js";
import { pathDisplayRoots } from "../render-human-types.js";
import type { CliBranding, CliExitCode } from "../types.js";
import type { WizardIo } from "./wizard-types.js";

/** What the closing checklist needs from the setup request. */
export interface GreenContext {
  readonly branding: CliBranding;
  readonly colorDepth: number;
  readonly environment: Environment;
  readonly registry: PluginRegistry;
  readonly stdout: Writable;
  readonly withDetail: boolean;
}

/** End on green: run the checks against a scan and render the closing checklist. */
export function endOnGreen(
  request: GreenContext,
  scan: WorkspaceScan,
  checks: readonly Check[],
  config: AuraEffectiveConfig,
): CliExitCode {
  const run = runChecks(checks, scan.model, config);
  const report = createCheckReport({
    adapters: request.registry.adapters,
    apps: scan.model.apps,
    checkDiagnostics: run.diagnostics,
    checks,
    findings: run.findings,
    findingsAffectExitCode: true,
    scanDiagnostics: scan.diagnostics,
    skipped: scan.skipped,
    withDetail: request.withDetail,
  });
  renderHumanCheckReport(report, request.branding, request.stdout, {
    checks,
    colorDepth: request.colorDepth,
    notes: [],
    roots: pathDisplayRoots(request.environment, scan.model.projectRoot),
    verbose: false,
  });
  return report.summary.exitCode;
}

/** Runs the checks whose findings a step asked for, reporting the ones that could not run. */
export function gatherFindings(
  checks: readonly Check[],
  model: WorkspaceScan["model"],
  io: WizardIo,
  config?: AuraEffectiveConfig,
): readonly Finding[] {
  const run = runChecks(checks, model, config);
  for (const diagnostic of run.diagnostics) {
    // Message only, never `detail`: it is verbatim text from a check that read the user's files.
    io.note(
      `${diagnostic.checkId} could not run, so its findings are missing: ${diagnostic.message}`,
    );
  }
  return run.findings;
}
