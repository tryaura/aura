import type { AuraManifest, AuraManifestState, FileOperation, FixPlan } from "@tryaura/aura-sdk";
import { createAuraManifestWriteOperation, createEmptyAuraManifest } from "@tryaura/core";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";

import type { SetupStepContext } from "./types.js";

/** A file the plan refuses to touch, and the reason the user can act on. */
export interface SetupBlocker {
  readonly path: string;
  readonly reason: string;
}

export interface SetupPlanOutcome {
  readonly blockers: readonly SetupBlocker[];
  /** The desired state the plan persists, recomputed from scratch every run. */
  readonly manifest: AuraManifest;
  readonly plan: FixPlan;
}

/**
 * Turns the final selections into the one fix plan `setup` applies.
 *
 * Pure and total: it always emits the full desired state rather than a delta, so a machine that
 * already matches previews as all-noop and "first run and fifth run are the same flow" needs no
 * memory of previous runs. Files whose read hit a problem are returned as blockers with their
 * operations omitted — the kernel would conflict on them anyway, but a blocker names the reason
 * where the user decides, not after confirmation.
 */
export function planSetup(context: SetupStepContext): SetupPlanOutcome {
  const blockers: SetupBlocker[] = [];
  const operations: FileOperation[] = [];
  const manifest = desiredManifest(context.manifest);
  const baseline = context.selections.baseline;

  if (context.manifest.status === "read-only") {
    blockers.push({ path: context.manifest.path, reason: context.manifest.problem.message });
  } else if (context.manifest.status === "ready" || baseline?.createManifest === true) {
    operations.push(createAuraManifestWriteOperation(context.manifest, manifest));
  }

  const shared = context.model.sharedInstructions;
  if (shared.problem !== undefined) {
    blockers.push({
      path: shared.path,
      reason: `Aura could not safely read this path (${shared.problem}) and will not overwrite it.`,
    });
  } else if (baseline?.createSharedInstructions === true) {
    operations.push({
      content: SHARED_INSTRUCTIONS_TEMPLATE,
      mode: 0o644,
      path: shared.path,
      type: "write",
    });
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    manifest,
    plan: Object.freeze({
      operations: Object.freeze(operations),
      summary: "Set up Aura on this machine from your selections.",
    }),
  });
}

function desiredManifest(state: AuraManifestState): AuraManifest {
  return state.status === "ready" ? state.value : createEmptyAuraManifest();
}
