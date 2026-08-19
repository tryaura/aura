import { basename } from "node:path";

import type { Scope } from "@tryaura/aura-sdk";

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
  type SetupStep,
  type SetupStepContext,
} from "../types.js";
import { runFormChain } from "../wizard-chain.js";
import type { WizardIo } from "../wizard-types.js";
import { relevantDuplicateClusters } from "./instruction-duplicates.js";
import {
  CONSOLIDATE_VALUE,
  scopeStages,
  SKIP_VALUE,
  TEMPLATE_VALUE,
  type ChainState,
  type ScopeDraft,
  type ScopeInput,
} from "./instruction-stages.js";

/**
 * The instructions step: one back-navigable chain of forms across both scopes.
 *
 * Each scope contributes action → sources → duplicate review → archive stages; a stage whose
 * precondition no longer holds (a non-consolidate action, no duplicated paragraphs left) simply
 * disappears from the chain. The chain runner owns ← navigation between the forms and re-seeds
 * re-asked questions with their previous answers.
 */
export const instructionsStep: SetupStep = {
  gather: async (context, io) => {
    const { global, project } = scopeInputs(context);
    if (context.revisited !== true) {
      emitScopeNotes(global, io);
      if (project !== undefined) {
        emitScopeNotes(project, io);
      }
    }

    const stages = [...scopeStages(global), ...(project === undefined ? [] : scopeStages(project))];
    const result = await runFormChain(stages, initialState(context), io, {
      entry: context.enteredBackward === true ? "end" : "start",
      flow: context.flow,
    });
    if (result === SETUP_ABORTED || result === SETUP_BACK) {
      return result;
    }

    const projectSelection =
      project === undefined ? undefined : scopeSelection(project, result.project);
    return {
      ...context.selections,
      instructions: {
        global: scopeSelection(global, result.global),
        ...(projectSelection === undefined ? {} : { project: projectSelection }),
      },
    };
  },
  compactTitle: "Instr",
  id: "instructions",
  needsFindings: true,
  title: "Instructions",
};

/** Everything both scopes need from the workspace; project is absent when it has nothing to do. */
function scopeInputs(context: SetupStepContext): {
  readonly global: ScopeInput;
  readonly project: ScopeInput | undefined;
} {
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
  const projectSources = inventory.filter((source) => source.scope === "project");
  const projectContent = instructionTargetContent(context.model, "project", targets.project);
  const project: ScopeInput | undefined =
    projectSources.length === 0 && projectContent === undefined
      ? undefined
      : {
          blocked: false,
          clusters,
          scope: "project",
          sources: projectSources,
          targetContentValue: projectContent,
          targetPath: targets.project,
        };
  return { global, project };
}

function scopeSelection(input: ScopeInput, draft: ScopeDraft): InstructionScopeSelection {
  if (input.blocked) {
    return inactiveSelection(input, "blocked");
  }
  if (draft.action !== CONSOLIDATE_VALUE) {
    return inactiveSelection(input, inactiveAction(draft.action, input.scope));
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
    archiveOriginals: draft.archiveOriginals === true,
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
function inactiveAction(action: string | undefined, scope: Scope): "keep" | "skip" | "template" {
  if (action === TEMPLATE_VALUE) {
    return "template";
  }
  return action === SKIP_VALUE && scope === "project" ? "skip" : "keep";
}

function inactiveSelection(
  input: ScopeInput,
  action: "blocked" | "keep" | "skip" | "template",
): InstructionScopeSelection {
  return {
    action,
    archiveOriginals: false,
    duplicateWinners: {},
    scope: input.scope,
    selectedSources: [],
    targetPath: input.targetPath,
  };
}

/** A re-entered step resumes from what this run already decided, not from cold-start defaults. */
function initialState(context: SetupStepContext): ChainState {
  const existing = context.selections.instructions;
  return { global: toDraft(existing?.global), project: toDraft(existing?.project) };
}

function toDraft(selection: InstructionScopeSelection | undefined): ScopeDraft {
  if (selection === undefined || selection.action === "blocked") {
    return {};
  }
  return {
    action: selection.action,
    archiveOriginals: selection.archiveOriginals,
    duplicateWinners: selection.duplicateWinners,
    selectedSources: selection.action === "consolidate" ? selection.selectedSources : undefined,
  };
}

function emitScopeNotes(input: ScopeInput, io: WizardIo): void {
  if (input.blocked) {
    io.note("Aura cannot configure shared instructions until their path can be read safely.");
    return;
  }
  if (input.sources.length > 0) {
    io.note(`Found ${describeSources(input.sources)} for ${input.scope} consolidation.`);
  }
}

function describeSources(sources: readonly InstructionSource[]): string {
  return sources
    .map((source) => `${basename(source.path)} (${describeInstructionSource(source)})`)
    .join(" and ");
}
