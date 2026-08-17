import { basename } from "node:path";

import type { Scope } from "@tryaura/aura-sdk";

import {
  describeInstructionSource,
  duplicateClusters,
  instructionInventory,
  instructionTargetContent,
  instructionTargets,
  type DuplicateCluster,
  type InstructionSource,
} from "../instructions.js";
import { SETUP_ABORTED, type InstructionScopeSelection, type SetupStep } from "../types.js";
import {
  selectedValues,
  type WizardIo,
  type WizardOption,
  type WizardQuestion,
} from "../wizard-types.js";
import { gatherDuplicateWinners } from "./instruction-duplicates.js";

const TEMPLATE_VALUE = "template";

export const instructionsStep: SetupStep = {
  gather: async (context, io) => {
    const inventory = instructionInventory(context.model);
    const targets = instructionTargets(context.model);
    const clusters = duplicateClusters(context.findings ?? []);
    const global = await gatherScope({
      blocked: context.model.sharedInstructions.problem !== undefined,
      clusters,
      io,
      scope: "global",
      sources: inventory.filter((source) => source.scope === "global"),
      targetContentValue: instructionTargetContent(context.model, "global", targets.global),
      targetPath: targets.global,
    });
    if (global === SETUP_ABORTED) {
      return SETUP_ABORTED;
    }

    const projectSources = inventory.filter((source) => source.scope === "project");
    const projectContent = instructionTargetContent(context.model, "project", targets.project);
    const project =
      projectSources.length === 0 && projectContent === undefined
        ? undefined
        : await gatherScope({
            blocked: false,
            clusters,
            io,
            scope: "project",
            sources: projectSources,
            targetContentValue: projectContent,
            targetPath: targets.project,
          });
    if (project === SETUP_ABORTED) {
      return SETUP_ABORTED;
    }

    return {
      ...context.selections,
      instructions: { global, ...(project === undefined ? {} : { project }) },
    };
  },
  id: "instructions",
  needsFindings: true,
  title: "Instructions",
};

interface GatherScopeInput {
  readonly blocked: boolean;
  readonly clusters: readonly DuplicateCluster[];
  readonly io: WizardIo;
  readonly scope: Scope;
  readonly sources: readonly InstructionSource[];
  readonly targetContentValue: string | undefined;
  readonly targetPath: string;
}

async function gatherScope(
  input: GatherScopeInput,
): Promise<InstructionScopeSelection | typeof SETUP_ABORTED> {
  if (input.blocked) {
    input.io.note("Aura cannot configure shared instructions until their path can be read safely.");
    return inactiveSelection(input, "blocked");
  }
  if (input.sources.length > 0) {
    input.io.note(`Found ${describeSources(input.sources)} for ${input.scope} consolidation.`);
  }

  const action = await gatherAction(input);
  if (action === SETUP_ABORTED) {
    return SETUP_ABORTED;
  }
  return action === "consolidate"
    ? gatherConsolidation(input)
    : inactiveSelection(input, action === "template" ? "template" : "keep");
}

async function gatherAction(input: GatherScopeInput): Promise<string | typeof SETUP_ABORTED> {
  const options = actionOptions(input);
  // The least invasive offered answer, which is what option order already encodes. Doubles as the
  // fallback, so a missing answer can never be an action that was not on the menu — "keep" is
  // absent when there is no target to keep, and choosing it would wire apps to nothing.
  const fallback = options[0]?.value ?? TEMPLATE_VALUE;
  const actionQuestion: WizardQuestion = {
    id: `${input.scope}-instruction-action`,
    initial: [fallback],
    kind: "select",
    label: input.scope === "global" ? "Global" : "Project",
    options,
    prompt: `How should Aura configure ${input.targetPath}?`,
  };
  const actionAnswer = await input.io.ask([actionQuestion]);
  if (actionAnswer === "aborted") {
    return SETUP_ABORTED;
  }
  return selectedValues(actionAnswer[actionQuestion.id])[0] ?? fallback;
}

/** Ordered least invasive first, which is what {@link gatherAction} proposes and `--yes` accepts. */
function actionOptions(input: GatherScopeInput): readonly WizardOption[] {
  const options: WizardOption[] = [];
  if ((input.targetContentValue?.trim().length ?? 0) > 0) {
    options.push({
      description: "Leave the existing shared file and every source untouched.",
      label: "Keep existing shared file",
      value: "keep",
    });
  }
  if (input.sources.length > 0) {
    options.push({
      description: "Merge selected sources with provenance and optional archival.",
      label: "Consolidate found instructions",
      value: "consolidate",
    });
  }
  options.push({
    description: "Start with Aura's minimal official instruction template.",
    label: "Use starter template",
    value: TEMPLATE_VALUE,
  });
  return options;
}

async function gatherConsolidation(
  input: GatherScopeInput,
): Promise<InstructionScopeSelection | typeof SETUP_ABORTED> {
  const sourceQuestion: WizardQuestion = {
    id: `${input.scope}-instruction-sources`,
    initial: input.sources.map((source) => source.path),
    kind: "multiselect",
    label: "Sources",
    options: input.sources.map((source) => ({
      description: describeInstructionSource(source),
      label: source.path,
      value: source.path,
    })),
    prompt: `Which ${input.scope} instruction files should Aura consolidate?`,
  };
  const sourceAnswer = await input.io.ask([sourceQuestion]);
  if (sourceAnswer === "aborted") {
    return SETUP_ABORTED;
  }
  const selectedSources = selectedValues(sourceAnswer[sourceQuestion.id]);
  const duplicateWinners = await gatherDuplicateWinners(
    input.scope,
    selectedSources,
    input.sources,
    input.clusters,
    input.io,
  );
  if (duplicateWinners === SETUP_ABORTED) {
    return SETUP_ABORTED;
  }

  // Defaults to the additive answer, because a question's `initial` is also what `--yes` accepts:
  // a non-interactive run must not be the one that removes files the user wrote by hand. Archival
  // is recoverable through the undo journal, but only after someone notices it happened.
  const archiveQuestion: WizardQuestion = {
    id: `${input.scope}-archive-originals`,
    initial: ["keep"],
    kind: "select",
    label: "Archive",
    options: [
      {
        description: "Leave every original source in place after creating the shared file.",
        label: "Keep originals in place",
        value: "keep",
      },
      {
        description:
          "Preserve exact originals in Aura's undo journal, then replace or remove them.",
        label: "Archive originals",
        value: "archive",
      },
    ],
    prompt: "What should Aura do with the selected originals after consolidation?",
  };
  const archiveAnswer = await input.io.ask([archiveQuestion]);
  if (archiveAnswer === "aborted") {
    return SETUP_ABORTED;
  }

  return {
    action: "consolidate",
    archiveOriginals: selectedValues(archiveAnswer[archiveQuestion.id]).includes("archive"),
    duplicateWinners,
    scope: input.scope,
    selectedSources,
    targetPath: input.targetPath,
  };
}

function inactiveSelection(
  input: GatherScopeInput,
  action: "blocked" | "keep" | "template",
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

function describeSources(sources: readonly InstructionSource[]): string {
  return sources
    .map((source) => `${basename(source.path)} (${describeInstructionSource(source)})`)
    .join(" and ");
}
