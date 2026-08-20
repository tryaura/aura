import { printable } from "./wizard-keys.js";
import type { WizardQuestionView } from "./wizard-render.js";
import { browseWindow, searchOptions } from "./wizard-search.js";
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
  /** Whether the `s` filter is narrowing a searchable multiselect to its checked rows. */
  showSelectedOnly: boolean;
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
    showSelectedOnly: false,
    text: question.initialText ?? "",
  };
}

/**
 * Where the cursor opens on a question: its current answer, else the first row it can act on.
 *
 * A select renders no per-row checkbox, so the cursor doubles as the pointer at what stands —
 * a re-seeded answer, or the `initial` a fresh form proposes. A seeded free-text draft focuses
 * the free-text row for the same reason.
 *
 * Failing that the cursor skips any leading disabled rows. Unavailable sources and rows a source
 * no longer publishes are deliberately listed ahead of the installable ones, and opening the
 * cursor on one of them means the first space struck does nothing at all — the row is there to be
 * read, not to be answered with.
 */
export function initialCursorRow(state: QuestionState | undefined): number {
  if (state === undefined) {
    return 0;
  }
  const options = visibleOptions(state);
  if (state.question.freeText === true && state.selected.size === 0 && state.text !== "") {
    return options.length;
  }
  const marked =
    state.question.kind === "select"
      ? options.findIndex((option) => state.selected.has(option.value))
      : -1;
  if (marked >= 0) {
    return marked;
  }
  return Math.max(
    options.findIndex((option) => option.disabled !== true),
    0,
  );
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
  if (option.members !== undefined) {
    return toggleMembers(state, option.members);
  }
  if (state.selected.has(option.value)) {
    state.selected.delete(option.value);
  } else {
    state.selected.add(option.value);
  }
  return true;
}

/** Checks every member of a pack row, or clears them all when every one is already checked. */
function toggleMembers(state: QuestionState, members: readonly string[]): boolean {
  if (members.length === 0) {
    return false;
  }
  const clearing = members.every((value) => state.selected.has(value));
  for (const value of members) {
    if (clearing) {
      state.selected.delete(value);
    } else {
      state.selected.add(value);
    }
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
  const visible = computeVisible(state);
  const options = visible.options;
  return {
    allOptions: state.question.options,
    answered: state.answered,
    question: options === state.question.options ? state.question : { ...state.question, options },
    searching: state.searching,
    ...(visible.searchTotal === undefined ? {} : { searchTotal: visible.searchTotal }),
    searchText: state.searchText,
    selected: state.answeredWithText ? new Set() : state.selected,
    showSelectedOnly: state.showSelectedOnly,
    text: state.text,
  };
}

/** Options currently on screen: a small first page, or every row matching the live query. */
export function visibleOptions(state: QuestionState): readonly WizardQuestion["options"][number][] {
  return computeVisible(state).options;
}

/**
 * The rows a searchable question shows, and — under a query — how many matched before the cap.
 *
 * With no query the checked rows lead under one `Selected (N)` heading, so the first frame is the
 * user's own selection rather than an alphabetical page; the {@link browseWindow} below it never
 * repeats them. Under a query the ranked matches lead and every checked row the query hides
 * follows under its own heading — marking a row must never make it disappear.
 */
function computeVisible(state: QuestionState): {
  readonly options: readonly WizardQuestion["options"][number][];
  readonly searchTotal?: number | undefined;
} {
  const search = state.question.search;
  if (search === undefined) {
    return { options: state.question.options };
  }
  const chosen = state.question.options.filter((option) => state.selected.has(option.value));
  if (state.showSelectedOnly) {
    return { options: regroup(chosen, `Selected (${String(chosen.length)})`) };
  }
  const query = state.searchText.trim();
  if (query !== "") {
    const outcome = searchOptions(state.question.options, query);
    const matched = new Set(outcome.matched.map((option) => option.value));
    const hidden = chosen.filter((option) => !matched.has(option.value));
    return {
      options: [
        ...regroup(outcome.matched, undefined),
        ...regroup(hidden, `Selected, not matching this filter (${String(hidden.length)})`),
      ],
      searchTotal: outcome.total,
    };
  }

  const chosenValues = new Set(chosen.map((option) => option.value));
  const window = browseWindow(
    state.question.options.filter((option) => !chosenValues.has(option.value)),
    search.initialLimit,
  );
  return {
    options: [...regroup(chosen, `Selected (${String(chosen.length)})`), ...window],
  };
}

/** The same rows under one synthetic heading — or none, for a ranked list that mixes sources. */
function regroup(
  options: readonly WizardQuestion["options"][number][],
  group: string | undefined,
): readonly WizardQuestion["options"][number][] {
  return options.map((option) => ({ ...option, group }));
}
