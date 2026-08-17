import type { Scope } from "@tryaura/aura-sdk";

import {
  describeInstructionSource,
  type DuplicateCluster,
  type InstructionSource,
} from "../instructions.js";
import type { ChainStage } from "../wizard-chain.js";
import { selectedValues, type WizardOption } from "../wizard-types.js";
import {
  duplicateQuestions,
  parseDuplicateWinners,
  relevantDuplicateClusters,
} from "./instruction-duplicates.js";

export const TEMPLATE_VALUE = "template";
export const CONSOLIDATE_VALUE = "consolidate";

/** What the chain has gathered for one scope so far; every field appears once its form resolves. */
export interface ScopeDraft {
  readonly action?: string | undefined;
  readonly archiveOriginals?: boolean | undefined;
  readonly duplicateWinners?: Readonly<Record<string, string>> | undefined;
  readonly selectedSources?: readonly string[] | undefined;
}

export type ChainState = Readonly<Record<Scope, ScopeDraft>>;

export interface ScopeInput {
  readonly blocked: boolean;
  readonly clusters: readonly DuplicateCluster[];
  readonly scope: Scope;
  readonly sources: readonly InstructionSource[];
  readonly targetContentValue: string | undefined;
  readonly targetPath: string;
}

export function scopeStages(input: ScopeInput): readonly ChainStage<ChainState>[] {
  const options = actionOptions(input);
  // The least invasive offered answer, which is what option order already encodes. Doubles as the
  // fallback, so a missing answer can never be an action that was not on the menu — "keep" is
  // absent when there is no target to keep, and choosing it would wire apps to nothing.
  const fallback = options[0]?.value ?? TEMPLATE_VALUE;
  const actionId = `${input.scope}-instruction-action`;
  const sourcesId = `${input.scope}-instruction-sources`;
  const archiveId = `${input.scope}-archive-originals`;
  const draft = (state: ChainState): ScopeDraft => state[input.scope];
  const update = (state: ChainState, patch: ScopeDraft): ChainState => ({
    ...state,
    [input.scope]: { ...state[input.scope], ...patch },
  });
  const consolidating = (state: ChainState): boolean => draft(state).action === CONSOLIDATE_VALUE;

  return [
    {
      apply: (state, answers) =>
        update(state, { action: selectedValues(answers[actionId])[0] ?? fallback }),
      questions: (state) =>
        input.blocked
          ? undefined
          : [
              {
                id: actionId,
                initial: [draft(state).action ?? fallback],
                kind: "select",
                label: input.scope === "global" ? "Global" : "Project",
                options,
                prompt: `How should Aura configure ${input.targetPath}?`,
              },
            ],
    },
    {
      apply: (state, answers) =>
        update(state, { selectedSources: selectedValues(answers[sourcesId]) }),
      questions: (state) =>
        consolidating(state)
          ? [
              {
                id: sourcesId,
                initial: draft(state).selectedSources ?? input.sources.map((source) => source.path),
                kind: "multiselect",
                label: "Sources",
                options: input.sources.map((source) => ({
                  description: describeInstructionSource(source),
                  label: source.path,
                  value: source.path,
                })),
                prompt: `Which ${input.scope} instruction files should Aura consolidate?`,
              },
            ]
          : undefined,
    },
    {
      apply: (state, answers) =>
        update(state, {
          duplicateWinners: parseDuplicateWinners(
            input.scope,
            relevantDuplicateClusters(draft(state).selectedSources ?? [], input.clusters),
            answers,
          ),
        }),
      questions: (state) => {
        if (!consolidating(state)) {
          return undefined;
        }
        const relevant = relevantDuplicateClusters(
          draft(state).selectedSources ?? [],
          input.clusters,
        );
        const questions = duplicateQuestions(
          input.scope,
          relevant,
          input.sources,
          draft(state).duplicateWinners ?? {},
        );
        return questions.length === 0 ? undefined : questions;
      },
    },
    {
      apply: (state, answers) =>
        update(state, {
          archiveOriginals: selectedValues(answers[archiveId]).includes("archive"),
        }),
      questions: (state) =>
        consolidating(state)
          ? [
              {
                id: archiveId,
                // Defaults to the additive answer, because a question's `initial` is also what
                // `--yes` accepts: a non-interactive run must not be the one that removes files
                // the user wrote by hand.
                initial: [draft(state).archiveOriginals === true ? "archive" : "keep"],
                kind: "select",
                label: "Archive",
                options: [
                  {
                    description:
                      "Leave every original source in place after creating the shared file.",
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
              },
            ]
          : undefined,
    },
  ];
}

/** Ordered least invasive first, which is what the action stage proposes and `--yes` accepts. */
function actionOptions(input: ScopeInput): readonly WizardOption[] {
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
      value: CONSOLIDATE_VALUE,
    });
  }
  options.push({
    description: "Start with Aura's minimal official instruction template.",
    label: "Use starter template",
    value: TEMPLATE_VALUE,
  });
  return options;
}
