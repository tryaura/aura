import { basename } from "node:path";

import type { Scope } from "@tryaura/aura-sdk";

import {
  describeInstructionSource,
  type DuplicateCluster,
  type InstructionSource,
} from "../instructions.js";
import type { ChainStage } from "../wizard-chain.js";
import {
  recommendedFirst,
  selectedValues,
  type WizardAnswer,
  type WizardOption,
} from "../wizard-types.js";
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

/**
 * The target's current text when this scope has nothing left to decide, otherwise undefined.
 *
 * A populated target with no sources to merge leaves a menu of two answers: one that changes
 * nothing, one that overwrites text Aura did not write. The step reports the state instead and the
 * scope settles on `keep`, which still wires any application missing its link.
 */
export function settledTargetContent(input: ScopeInput): string | undefined {
  if (input.blocked || input.sources.length > 0 || !hasTargetContent(input)) {
    return undefined;
  }
  return input.targetContentValue;
}

export function scopeStages(input: ScopeInput): readonly ChainStage<ChainState>[] {
  if (settledTargetContent(input) !== undefined) {
    return [];
  }
  const options = actionOptions(input);
  const offered = new Set(options.map((option) => option.value));
  // The leading row, which is one value behind all four of: what the menu recommends, what it
  // proposes, what `--yes` accepts, and what a missing answer falls back to. `recommendedFirst`
  // is what keeps them one value — combining leads wherever there is anything to combine, and
  // where there is not, first place is the least invasive answer that still configures the scope.
  // Never the opt-out: it is ordered last deliberately, since proposing it would make every
  // non-interactive run silently decline the scope. "keep" is absent when there is no target to
  // keep, so falling back can never wire applications to nothing.
  const fallback = options[0]?.value ?? TEMPLATE_VALUE;
  const actionId = `${input.scope}-instruction-action`;
  const sourcesId = `${input.scope}-instruction-sources`;
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
 * Built least invasive first with the opt-out last, then led by the recommended row.
 *
 * Combining is recommended wherever the scan found anything to combine: it is what the step exists
 * to do, and the answer that leaves one instruction file instead of several. Hoisting it puts the
 * advice, the mark and the cursor on row `1.` together, and leaves the rest of the menu in the
 * order it was built. A scope with nothing to combine recommends nothing and keeps that order.
 *
 * The opt-out is offered on the project scope only. Declining the global scope would leave INS-001
 * and INS-002 firing at error severity, so setup could not end on green — an answer the wizard
 * offers should not be one the closing checklist then fails the run over. The project tier has no
 * error-severity counterpart, so a declined project scope still ends green.
 */
function actionOptions(input: ScopeInput): readonly WizardOption[] {
  const options: WizardOption[] = [];
  if (hasTargetContent(input)) {
    options.push({
      description: "Leave the existing shared file and every source untouched.",
      label: "Keep existing shared file",
      value: "keep",
    });
  }
  if (input.sources.length > 0) {
    options.push({
      description: `Move instructions from the files you select into this ${basename(input.targetPath)} file. Aura backs up the originals for undo.`,
      label: "Combine found instructions",
      recommended: true,
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
      description: hasTargetContent(input)
        ? `Aura writes nothing here and adds no project-level link; ${basename(input.targetPath)} and anything already linking to it stay as they are.`
        : "Aura writes nothing here and adds no project-level link.",
      label: "Skip project instructions",
      value: SKIP_VALUE,
    });
  }
  return recommendedFirst(options);
}

function hasTargetContent(input: ScopeInput): boolean {
  return (input.targetContentValue?.trim().length ?? 0) > 0;
}
