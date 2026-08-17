import { SETUP_ABORTED, SETUP_BACK } from "./types.js";
import type { WizardAnswers, WizardIo, WizardQuestion } from "./wizard-types.js";

/**
 * One form of a step's internal sequence.
 *
 * `questions` derives the form from the state so far — returning undefined skips the stage, which
 * is how conditional forms (duplicate review, project scope) appear and disappear as earlier
 * answers change. `apply` folds the answers back into the state.
 */
export interface ChainStage<S> {
  readonly apply: (state: S, answers: WizardAnswers) => S;
  readonly questions: (state: S) => readonly WizardQuestion[] | undefined;
}

/** Which end of the chain a run opens on; "end" is how ← re-enters an already-answered step. */
export type ChainEntry = "end" | "start";

/**
 * Runs a step's forms in order with ← navigation between them.
 *
 * A form resolving `"back"` rewinds to the previously asked stage with the state it saw then;
 * stages that were skipped are recomputed on the way forward, so a changed answer regrows the
 * chain from that point. Answers given further ahead are remembered by question id and re-seeded
 * as `initial` when their form comes around again, so going back does not cost the answers after
 * it. Backing out of the first asked stage returns {@link SETUP_BACK} for the orchestrator.
 *
 * Entering at `"end"` opens on the last stage the seeded state answers, with the earlier stages
 * stacked as history so ← keeps walking backward through them; a chain with nothing to ask
 * resolves {@link SETUP_BACK} immediately, so backing over an inert step keeps going.
 */
export async function runFormChain<S>(
  stages: readonly ChainStage<S>[],
  initial: S,
  io: WizardIo,
  entry: ChainEntry = "start",
): Promise<S | typeof SETUP_ABORTED | typeof SETUP_BACK> {
  const history: { index: number; state: S }[] = [];
  const remembered = new Map<string, readonly string[]>();
  let state = initial;
  let index = 0;

  if (entry === "end") {
    const asked = stages.flatMap((stage, position) => {
      const questions = stage.questions(state);
      return questions === undefined || questions.length === 0 ? [] : [position];
    });
    const last = asked.at(-1);
    if (last === undefined) {
      return SETUP_BACK;
    }
    // The seeded state carries every earlier answer, so it stands in for each history entry.
    history.push(...asked.slice(0, -1).map((position) => ({ index: position, state })));
    index = last;
  }

  while (index < stages.length) {
    const stage = stages[index];
    const questions = stage?.questions(state);
    if (stage === undefined || questions === undefined || questions.length === 0) {
      index += 1;
      continue;
    }

    const result = await io.ask(questions.map((question) => reseed(question, remembered)));
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      const previous = history.pop();
      if (previous === undefined) {
        return SETUP_BACK;
      }
      index = previous.index;
      state = previous.state;
      continue;
    }

    remember(remembered, result);
    history.push({ index, state });
    state = stage.apply(state, result);
    index += 1;
  }
  return state;
}

function remember(remembered: Map<string, readonly string[]>, answers: WizardAnswers): void {
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.kind === "options") {
      remembered.set(id, answer.values);
    }
  }
}

/** Re-seeds a re-asked question with the answer it got last time, when it still fits. */
function reseed(
  question: WizardQuestion,
  remembered: ReadonlyMap<string, readonly string[]>,
): WizardQuestion {
  const values = remembered.get(question.id);
  if (values === undefined) {
    return question;
  }
  const offered = new Set(question.options.map((option) => option.value));
  return values.every((value) => offered.has(value)) ? { ...question, initial: values } : question;
}
