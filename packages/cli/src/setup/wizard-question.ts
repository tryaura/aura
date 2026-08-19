import { printable } from "./wizard-keys.js";
import type { WizardQuestionView } from "./wizard-render.js";
import type { Keypress, WizardAnswer, WizardAnswers, WizardQuestion } from "./wizard-types.js";

/** One question's mutable state while its form is on screen; the session in `wizard-form.ts` owns it. */
export interface QuestionState {
  answered: boolean;
  /** Whether the recorded answer is the free-text draft rather than the selection. */
  answeredWithText: boolean;
  readonly question: WizardQuestion;
  /** Whether printable keys are currently editing this question's search query. */
  searching: boolean;
  /** The live local filter for a searchable question. */
  searchText: string;
  readonly selected: Set<string>;
  text: string;
}

export function createQuestionState(question: WizardQuestion): QuestionState {
  return {
    answered: false,
    answeredWithText: false,
    question,
    searching: false,
    searchText: "",
    selected: new Set(question.initial ?? []),
    text: question.initialText ?? "",
  };
}

/**
 * Where the cursor opens on a question: its current answer, else the first row.
 *
 * A select renders no per-row checkbox, so the cursor doubles as the pointer at what stands —
 * a re-seeded answer, or the `initial` a fresh form proposes. A seeded free-text draft focuses
 * the free-text row for the same reason.
 */
export function initialCursorRow(state: QuestionState | undefined): number {
  if (state === undefined) {
    return 0;
  }
  const options = visibleOptions(state);
  if (state.question.freeText === true && state.selected.size === 0 && state.text !== "") {
    return options.length;
  }
  if (state.question.kind !== "select") {
    return 0;
  }
  const index = options.findIndex((option) => state.selected.has(option.value));
  return index < 0 ? 0 : index;
}

/** Edits the free-text draft; space types a space here rather than toggling anything. */
export function editFreeText(keypress: Keypress, state: QuestionState): boolean {
  if (keypress.name === "backspace") {
    // Code points, not UTF-16 units: `printable` admits astral characters like emoji, and a
    // string-index slice would cut one in half and leave a lone surrogate in the draft.
    state.text = [...state.text].slice(0, -1).join("");
    return true;
  }

  const typed = printable(keypress);
  if (typed === undefined) {
    return false;
  }
  state.text += typed;
  return true;
}

/**
 * Marks the option on `row` without answering the question: a multiselect toggles it, a select
 * moves its single mark to it.
 *
 * Space stops at marking on purpose — the row shows what would stand, and ↵ is still the only key
 * that answers the question and moves on.
 */
export function markRow(
  state: QuestionState,
  row: number,
  options: readonly WizardQuestion["options"][number][] = state.question.options,
): boolean {
  const marked =
    state.question.kind === "multiselect"
      ? toggle(state, row, options)
      : choose(state, row, options);
  if (marked) {
    // A question answered with free text renders no selection at all, so a mark left behind it
    // would be invisible; what was just marked is what the question now says.
    state.answeredWithText = false;
  }
  return marked;
}

/**
 * Toggles the multi-select option on `row`.
 *
 * A disabled option can be cleared but never selected. Refusing both directions would strand any
 * selection that was seeded before the option became unavailable, with no way to give it up.
 */
function toggle(
  state: QuestionState,
  row: number,
  options: readonly WizardQuestion["options"][number][],
): boolean {
  const option = options[row];
  if (option === undefined || (option.disabled === true && !state.selected.has(option.value))) {
    return false;
  }
  if (state.selected.has(option.value)) {
    state.selected.delete(option.value);
  } else {
    state.selected.add(option.value);
  }
  return true;
}

/** Moves a select's single mark to `row`; a disabled option can never take it. */
function choose(
  state: QuestionState,
  row: number,
  options: readonly WizardQuestion["options"][number][],
): boolean {
  const option = options[row];
  if (option === undefined || option.disabled === true) {
    return false;
  }
  state.selected.clear();
  state.selected.add(option.value);
  return true;
}

/** Answers the question with the row the cursor is on: free text, or a select's chosen option. */
export function answerActive(
  state: QuestionState,
  row: number,
  options: readonly WizardQuestion["options"][number][] = state.question.options,
): void {
  if (state.question.freeText === true && row === options.length) {
    state.answered = state.text !== "";
    state.answeredWithText = state.answered;
    return;
  }
  if (state.question.kind === "select") {
    const option = options[row];
    if (option === undefined || option.disabled === true) {
      return;
    }
    state.selected.clear();
    state.selected.add(option.value);
  }
  state.answered = true;
  state.answeredWithText = false;
}

export function collectAnswers(states: readonly QuestionState[]): WizardAnswers {
  const answers: Record<string, WizardAnswer> = {};
  for (const state of states) {
    answers[state.question.id] = state.answeredWithText
      ? { kind: "text", text: state.text }
      : {
          kind: "options",
          values: state.question.options
            .map((option) => option.value)
            .filter((value) => state.selected.has(value)),
        };
  }
  return Object.freeze(answers);
}

export function toView(state: QuestionState): WizardQuestionView {
  const options = visibleOptions(state);
  return {
    allOptions: state.question.options,
    answered: state.answered,
    question: options === state.question.options ? state.question : { ...state.question, options },
    searching: state.searching,
    searchText: state.searchText,
    selected: state.answeredWithText ? new Set() : state.selected,
    text: state.text,
  };
}

/** Options currently on screen: a small first page, or every row matching the live query. */
export function visibleOptions(state: QuestionState): readonly WizardQuestion["options"][number][] {
  const search = state.question.search;
  if (search === undefined) {
    return state.question.options;
  }
  const query = state.searchText.trim().toLocaleLowerCase();
  if (query !== "") {
    const terms = query.split(/\s+/u);
    return state.question.options.filter((option) => {
      const haystack = [option.label, option.description, option.group, option.value]
        .filter((value) => value !== undefined)
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  const initial = state.question.options.slice(0, search.initialLimit);
  const visibleValues = new Set(initial.map((option) => option.value));
  return [
    ...initial,
    ...state.question.options.filter(
      (option) => state.selected.has(option.value) && !visibleValues.has(option.value),
    ),
  ];
}
