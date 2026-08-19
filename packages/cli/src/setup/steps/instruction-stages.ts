import { basename } from "node:path";

import type { Scope } from "@tryaura/aura-sdk";

import {
  describeInstructionSource,
  type DuplicateCluster,
  type InstructionSource,
} from "../instructions.js";
import type { ChainStage } from "../wizard-chain.js";
import { selectedValues, type WizardAnswer, type WizardOption } from "../wizard-types.js";
import {
  duplicateQuestions,
  parseDuplicateWinners,
  relevantDuplicateClusters,
} from "./instruction-duplicates.js";

export const TEMPLATE_VALUE = "template";
export const CONSOLIDATE_VALUE = "consolidate";
export const SKIP_VALUE = "skip";

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
  const offered = new Set(options.map((option) => option.value));
  // The least invasive offered answer that still configures the scope, which is what option order
  // encodes up to the opt-out. Doubles as the fallback, so a missing answer can never be an action
  // that was not on the menu — "keep" is absent when there is no target to keep, and choosing it
  // would wire apps to nothing. The opt-out sits outside that ordering deliberately: it is the
  // least invasive answer of all, and first place is also what `--yes` accepts, so putting it there
  // would make every non-interactive run silently decline the scope.
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
      isApplicable: () => !input.blocked,
      label: input.scope === "global" ? "Global" : "Project",
      apply: (state, answers) =>
        update(state, { action: settled(answers[actionId], offered, fallback) }),
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
      isApplicable: consolidating,
      label: "Sources",
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
      compactLabel: "Dups",
      isApplicable: (state) =>
        consolidating(state) &&
        relevantDuplicateClusters(draft(state).selectedSources ?? [], input.clusters).some(
          (cluster) => !cluster.identical,
        ),
      label: "Duplicates",
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
      isApplicable: consolidating,
      label: "Files",
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
                label: "Files",
                options: [
                  {
                    description: `Keep the existing instructions in the selected files. Aura will also copy them to ${basename(input.targetPath)}.`,
                    label: "Keep instructions in both places",
                    value: "keep",
                  },
                  {
                    description: `Back up the selected files, then replace them with links to ${basename(input.targetPath)} or delete them if no link is needed.`,
                    label: `Keep instructions only in ${basename(input.targetPath)}`,
                    value: "archive",
                  },
                ],
                prompt: `After Aura copies the selected instructions to ${basename(input.targetPath)}, where should they stay?`,
              },
            ]
          : undefined,
    },
  ];
}

/**
 * An answer this menu never offered is not an answer.
 *
 * The opt-out exists on one scope and `keep` only where there is a target to keep, so a value
 * arriving from anywhere but these options — a scripted run, a hand-built draft — could otherwise
 * decline a scope the wizard deliberately gave no way to decline. Falls back for the same reason
 * the fallback exists at all, and mirrors how the chain re-seeds only values still on offer.
 */
function settled(
  answer: WizardAnswer | undefined,
  offered: ReadonlySet<string>,
  fallback: string,
): string {
  const value = selectedValues(answer)[0];
  return value !== undefined && offered.has(value) ? value : fallback;
}

/**
 * Ordered least invasive first, which is what the action stage proposes and `--yes` accepts, with
 * the opt-out last.
 *
 * The opt-out is offered on the project scope only. Declining the global scope would leave INS-001
 * and INS-002 firing at error severity, so setup could not end on green — an answer the wizard
 * offers should not be one the closing checklist then fails the run over. The project tier has no
 * error-severity counterpart, so a declined project scope still ends green.
 */
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
      description: `Copy instructions from the files you select into this ${basename(input.targetPath)} file.`,
      label: "Combine found instructions",
      value: CONSOLIDATE_VALUE,
    });
  }
  options.push({
    description: `Create this ${basename(input.targetPath)} file with Aura's basic instructions.`,
    label: "Use starter template",
    value: TEMPLATE_VALUE,
  });
  if (input.scope === "project") {
    options.push({
      // Declining is not undoing: an earlier run's target and the link pointing at it survive this
      // answer untouched, and a converged summary saying "nothing to do" would be the only thing
      // the user ever heard about them.
      description:
        (input.targetContentValue?.trim().length ?? 0) > 0
          ? `Aura writes nothing here and adds no project-level link; ${basename(input.targetPath)} and anything already linking to it stay as they are.`
          : "Aura writes nothing here and adds no project-level link.",
      label: "Skip project instructions",
      value: SKIP_VALUE,
    });
  }
  return options;
}
