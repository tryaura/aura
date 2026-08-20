import type { AuraEffectiveConfig, AuraManifest, Check, SetupRunOutcome } from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  prepareFixPlan,
  refreshMcpSources,
  type WorkspaceScan,
} from "@tryaura/core";

import { safe } from "../safe-text.js";
import type { CliExitCode } from "../types.js";
import { gatherSelections, toFlowStep, type GatherStart } from "./gather.js";
import { endOnGreen } from "./green.js";
import { planSetup } from "./planner.js";
import type { SetupRequest } from "./setup.js";
import { renderConvergedSetup, renderSetupSummary } from "./summary.js";
import type { SetupStep, SetupStepContext } from "./types.js";

export type PreparedPlan = Awaited<ReturnType<typeof prepareFixPlan>>;

type PlanOutcome =
  | { readonly kind: "blocked"; readonly manifest: AuraManifest }
  | { readonly kind: "converged"; readonly manifest: AuraManifest }
  | { readonly kind: "ready"; readonly manifest: AuraManifest; readonly prepared: PreparedPlan };

type PassOutcome =
  | {
      readonly kind: "apply";
      readonly manifest: AuraManifest;
      /** What this pass planned from, so a raced apply can re-plan the same selections. */
      readonly planInputs: Parameters<typeof planSetup>[0];
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
// fallow-ignore-next-line complexity -- classifies every way one gather-plan-confirm pass can end.
export async function runPass(
  request: SetupRequest,
  steps: readonly SetupStep[],
  stepContext: Omit<SetupStepContext, "selections">,
  scan: WorkspaceScan,
  start: GatherStart,
  activeChecks: readonly Check[],
  config: AuraEffectiveConfig,
): Promise<PassOutcome> {
  const { branding, io, stdout } = request;
  const gathered = await gatherSelections(steps, stepContext, io, start);
  if (gathered.status === "invalid-dependency") {
    request.stderr.write(
      `${branding.displayName}: the ${safe(gathered.stepTitle)} step needs ${safe(gathered.missing)}. Run ${branding.command} setup to establish it, then retry this command.\n`,
    );
    if (stepContext.repoPreset?.recorded === true) {
      stdout.write(leftUnchanged(stepContext));
    }
    return { code: 2, kind: "exit", outcome: "unusable" };
  }
  if (gathered.status === "aborted") {
    stdout.write(leftUnchanged(stepContext));
    return { code: 1, kind: "exit", outcome: "aborted" };
  }
  const selections = gathered.selections;

  const planInputs = { ...stepContext, selections };
  const planned = await previewPlan(request, planInputs);
  if (planned.kind === "converged") {
    if (stepContext.repoPreset?.recorded === true) {
      stdout.write(leftUnchanged(stepContext));
    }
    return {
      code: endOnGreen(request, scan, activeChecks, config),
      kind: "exit",
      manifest: planned.manifest,
      outcome: "converged",
    };
  }
  if (planned.kind === "blocked") {
    if (stepContext.repoPreset?.recorded === true) {
      stdout.write(leftUnchanged(stepContext));
    }
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
    stdout.write(leftUnchanged(stepContext));
    return confirmation === "aborted"
      ? { code: 1, kind: "exit", manifest: planned.manifest, outcome: "aborted" }
      : { code: 0, kind: "exit", manifest: planned.manifest, outcome: "declined" };
  }
  return { kind: "apply", manifest: planned.manifest, planInputs, prepared: planned.prepared };
}

/**
 * The closing line for a pass that applied nothing.
 *
 * A run that recorded repository preset trust during boot did write one file, and "left everything
 * as it was" is the one sentence a user checks against their own filesystem.
 */
function leftUnchanged(stepContext: Omit<SetupStepContext, "selections">): string {
  return stepContext.repoPreset?.recorded === true
    ? `\nRecorded your trust of ${AURA_TEAM_PRESET_PATH}. Left everything else as it was.\n`
    : "\nLeft everything as it was.\n";
}

/** Plans the gathered selections, renders the summary, and classifies what can happen next. */
async function previewPlan(
  request: SetupRequest,
  inputs: Parameters<typeof planSetup>[0],
): Promise<PlanOutcome> {
  const { stdout } = request;
  // The scan ran before the wizard's prompts, and MCP configuration files churn under other
  // processes in exactly that gap — `~/.claude.json` most of all. Planning against a fresh read
  // shrinks the stale-precondition window from the wizard's runtime to the moments below.
  await refreshMcpSources(inputs.model);
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
    const recorded = inputs.repoPreset?.recorded === true;
    request.stderr.write(
      `${request.branding.displayName}: the plan is blocked by the current state of these files; ${recorded ? "the repository preset trust record was the only change" : "nothing was changed"}.\n`,
    );
    return { kind: "blocked", manifest: outcome.manifest };
  }
  return { kind: "ready", manifest: outcome.manifest, prepared };
}
