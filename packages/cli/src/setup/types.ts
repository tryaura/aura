import type { AuraManifestState, WorkspaceModel } from "@tryaura/aura-sdk";

import type { WizardIo } from "./wizard-types.js";

/** What the baseline step decided; see `steps/baseline.ts`. */
interface BaselineSelections {
  readonly createManifest: boolean;
  readonly createSharedInstructions: boolean;
}

/**
 * Everything the wizard has decided so far, one optional slice per step id.
 *
 * A typed record rather than a stringly-keyed map: the planner switches on these exhaustively, and
 * a step that runs alone (AURA-30's `--add`) simply leaves the other slices absent, which the
 * planner resolves as "keep the current state for that concern".
 */
export interface SetupSelections {
  readonly baseline?: BaselineSelections | undefined;
}

export interface SetupStepContext {
  readonly manifest: AuraManifestState;
  readonly model: WorkspaceModel;
  readonly selections: SetupSelections;
}

/** The out-of-band outcome of a step the user backed out of. */
export const SETUP_ABORTED: unique symbol = Symbol("aura.setup.aborted");

type SetupStepOutcome = SetupSelections | typeof SETUP_ABORTED;

/**
 * One wizard step.
 *
 * `gather` prompts through `io` and returns the selections extended with its own slice — it never
 * touches the filesystem. All writing happens once, after the last step, through a single fix plan;
 * that is what makes "abort at any step leaves the machine untouched" structural rather than
 * something each step has to get right.
 */
export interface SetupStep {
  readonly gather: (context: SetupStepContext, io: WizardIo) => Promise<SetupStepOutcome>;
  readonly id: string;
  readonly title: string;
}
