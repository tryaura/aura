import { basename } from "node:path";

import {
  describeInstructionSource,
  duplicateClusters,
  instructionInventory,
  instructionTargetContent,
  instructionTargets,
  type InstructionSource,
} from "../instructions.js";
import {
  SETUP_ABORTED,
  SETUP_BACK,
  type InstructionScopeSelection,
  type SetupSelections,
  type SetupStep,
  type SetupStepContext,
  type SetupStepUnoffered,
} from "../types.js";
import { runFormChain } from "../wizard-chain.js";
import type { WizardIo } from "../wizard-types.js";
import { relevantDuplicateClusters } from "./instruction-duplicates.js";
import {
  CONSOLIDATE_VALUE,
  scopeStages,
  settledTargetContent,
  TEMPLATE_VALUE,
  type ChainState,
  type ScopeDraft,
  type ScopeInput,
} from "./instruction-stages.js";

/**
 * The instructions step: one back-navigable chain of forms for personal instructions.
 *
 * Each scope contributes action → sources → duplicate review stages; a stage whose precondition no
 * longer holds (a non-consolidate action, no duplicated paragraphs left) simply disappears from
 * the chain. The chain runner owns ← navigation between the forms and re-seeds re-asked questions
 * with their previous answers.
 */
export const instructionsStep: SetupStep = {
  gather: async (context, io) => {
    const inputs = scopeInputs(context);
    if (context.revisited !== true) {
      emitScopeNotes(inputs.global, io);
    }

    const stages = scopeStages(inputs.global);
    const result = await runFormChain(stages, initialState(context), io, {
      entry: context.enteredBackward === true ? "end" : "start",
      flow: context.flow,
    });
    if (result === SETUP_ABORTED || result === SETUP_BACK) {
      return result;
    }
    return settle(context, inputs, result, stages.length === 0);
  },
  compactTitle: "Instr",
  id: "instructions",
  needsFindings: true,
  telemetryCategory: "instructions",
  title: "Instructions",
};

interface ScopeInputs {
  readonly global: ScopeInput;
}

/** Folds the personal draft into the step's selections, unoffered when it asked nothing to do it. */
function settle(
  context: SetupStepContext,
  inputs: ScopeInputs,
  result: ChainState,
  unoffered: boolean,
): SetupSelections | SetupStepUnoffered {
  const selections: SetupSelections = {
    ...context.selections,
    instructions: {
      global: scopeSelection(inputs.global, result.global),
    },
  };
  // Every scope settled on its own, so the step recorded what it settled without asking: an answer
  // nobody was asked for must not be counted as one they gave.
  return unoffered ? { selections, unoffered: true } : selections;
}

/** Everything personal instruction setup needs from the workspace. */
function scopeInputs(context: SetupStepContext): ScopeInputs {
  const inventory = instructionInventory(context.model);
  const targets = instructionTargets(context.model);
  const clusters = duplicateClusters(context.findings ?? []);

  const global: ScopeInput = {
    blocked: context.model.sharedInstructions.problem !== undefined,
    clusters,
    scope: "global",
    sources: inventory.filter((source) => source.scope === "global"),
    targetContentValue: instructionTargetContent(context.model, "global", targets.global),
    targetPath: targets.global,
  };
  return { global };
}

function scopeSelection(input: ScopeInput, draft: ScopeDraft): InstructionScopeSelection {
  if (input.blocked) {
    return inactiveSelection(input, "blocked");
  }
  if (draft.action !== CONSOLIDATE_VALUE) {
    return inactiveSelection(input, inactiveAction(draft.action));
  }
  const selectedSources = draft.selectedSources ?? [];
  // Winners can outlive the sources whose duplicates they resolved; only those a still-relevant
  // cluster explains are carried into the selection.
  const relevant = relevantDuplicateClusters(selectedSources, input.clusters);
  const duplicateWinners = Object.fromEntries(
    Object.entries(draft.duplicateWinners ?? {}).filter(([id]) =>
      relevant.some((cluster) => cluster.id === id),
    ),
  );
  return {
    action: "consolidate",
    duplicateWinners,
    scope: input.scope,
    selectedSources,
    targetPath: input.targetPath,
  };
}

/**
 * Maps a settled non-consolidate answer, defaulting to the one that touches nothing it was given.
 *
 * The opt-out is honoured only where it was offered. Declining the global scope leaves INS-001 and
 * INS-002 firing at error severity, so the action menu never offers it there; this mapping is the
 * second half of that rule, keeping an action off the menu from becoming one the planner obeys.
 */
function inactiveAction(action: string | undefined): "keep" | "template" {
  if (action === TEMPLATE_VALUE) {
    return "template";
  }
  return "keep";
}

function inactiveSelection(
  input: ScopeInput,
  action: "blocked" | "keep" | "template",
): InstructionScopeSelection {
  return {
    action,
    duplicateWinners: {},
    scope: input.scope,
    selectedSources: [],
    targetPath: input.targetPath,
  };
}

/** A re-entered step resumes from what this run already decided, not from cold-start defaults. */
function initialState(context: SetupStepContext): ChainState {
  const existing = context.selections.instructions;
  return { global: toDraft(existing?.global) };
}

function toDraft(selection: InstructionScopeSelection | undefined): ScopeDraft {
  if (selection === undefined || selection.action === "blocked") {
    return {};
  }
  return {
    action: selection.action,
    duplicateWinners: selection.duplicateWinners,
    selectedSources: selection.action === "consolidate" ? selection.selectedSources : undefined,
  };
}

function emitScopeNotes(input: ScopeInput, io: WizardIo): void {
  if (input.blocked) {
    io.note("Aura cannot configure shared instructions until their path can be read safely.");
    return;
  }
  const settled = settledTargetContent(input);
  if (settled !== undefined) {
    // The state, in place of the question this scope no longer asks: without it, a converged scope
    // would pass by in silence and the run would never say which file its applications now read.
    const size = describeInstructionSource({
      content: settled,
      path: input.targetPath,
      scope: input.scope,
    });
    io.note(
      `Personal instructions already live in ${input.targetPath} (${size}); Aura found nothing else to consolidate and leaves the file as it is.`,
    );
    return;
  }
  if (input.sources.length > 0) {
    io.note(`Found ${describeSources(input.sources)} for personal consolidation.`);
  }
}

function describeSources(sources: readonly InstructionSource[]): string {
  return sources
    .map((source) => `${basename(source.path)} (${describeInstructionSource(source)})`)
    .join(" and ");
}
