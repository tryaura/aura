import type { WizardFrame, WizardQuestionView } from "./wizard-render.js";
import type { WizardAnswer, WizardAnswers, WizardQuestion } from "./wizard-types.js";

/** One decoded key, however the terminal happened to encode it. */
export interface Keypress {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly name: string | undefined;
  readonly sequence: string | undefined;
}

/** What one key did to the form. */
type FormEvent = "abort" | "none" | "repaint" | "submit";

/**
 * The wizard form's state machine, free of any I/O.
 *
 * The prompt engine feeds it keypresses and repaints; tests can drive it directly. All navigation
 * rules live here: ←/→ and tab move between question tabs, ↑/↓ move the cursor, space toggles a
 * multi-select row, digits jump to a row, enter answers and advances, and the Submit tab resolves
 * the form once every question is answered.
 */
export interface FormSession {
  /** The recorded answers; only meaningful after `handle` returned `"submit"`. */
  readonly answers: () => WizardAnswers;
  readonly frame: () => WizardFrame;
  readonly handle: (keypress: Keypress) => FormEvent;
  readonly views: () => readonly WizardQuestionView[];
}

interface QuestionState {
  answered: boolean;
  /** Whether the recorded answer is the free-text draft rather than the selection. */
  answeredWithText: boolean;
  readonly question: WizardQuestion;
  readonly selected: Set<string>;
  text: string;
}

export function createFormSession(questions: readonly WizardQuestion[]): FormSession {
  const states: readonly QuestionState[] = questions.map((question) => ({
    answered: false,
    answeredWithText: false,
    question,
    selected: new Set(question.initial ?? []),
    text: "",
  }));
  const tabCount = questions.length + 1;
  let activeTab = 0;
  let cursorRow = 0;

  const handle = (keypress: Keypress): FormEvent => {
    const state = states[activeTab];

    if (keypress.name === "escape" || (keypress.ctrl && keypress.name === "c")) {
      return "abort";
    }

    if (keypress.name === "return" || keypress.name === "enter") {
      if (state === undefined) {
        const unanswered = states.findIndex((candidate) => !candidate.answered);
        if (unanswered === -1) {
          return "submit";
        }
        activeTab = unanswered;
        cursorRow = 0;
        return "repaint";
      }
      answerActive(state, cursorRow);
      // A one-question form has nothing left to review, so answering it is submitting it.
      if (states.length === 1 && state.answered) {
        return "submit";
      }
      activeTab = nextTab(states, activeTab);
      cursorRow = 0;
      return "repaint";
    }

    return applyNavigation(keypress, state) ? "repaint" : "none";
  };

  /** Returns true when the key changed the frame. */
  const applyNavigation = (keypress: Keypress, state: QuestionState | undefined): boolean => {
    if (keypress.name === "left") {
      activeTab = (activeTab - 1 + tabCount) % tabCount;
      cursorRow = 0;
      return true;
    }
    if (keypress.name === "right" || keypress.name === "tab") {
      activeTab = (activeTab + 1) % tabCount;
      cursorRow = 0;
      return true;
    }
    if (state === undefined) {
      return false;
    }

    const rows = rowCount(state.question);
    if (keypress.name === "up" && rows > 0) {
      cursorRow = (cursorRow - 1 + rows) % rows;
      return true;
    }
    if (keypress.name === "down" && rows > 0) {
      cursorRow = (cursorRow + 1) % rows;
      return true;
    }
    return applyTextOrToggle(keypress, state);
  };

  const applyTextOrToggle = (keypress: Keypress, state: QuestionState): boolean => {
    const onFreeText =
      state.question.freeText === true && cursorRow === state.question.options.length;

    if (keypress.name === "space" && !onFreeText) {
      const option = state.question.options[cursorRow];
      if (option !== undefined && state.question.kind === "multiselect") {
        toggle(state.selected, option.value);
        return true;
      }
      return false;
    }

    if (onFreeText) {
      if (keypress.name === "backspace") {
        state.text = state.text.slice(0, -1);
        return true;
      }
      const typed = printable(keypress);
      if (typed !== undefined) {
        state.text += typed;
        return true;
      }
      return false;
    }

    const digit = digitRow(keypress, state.question);
    if (digit !== undefined) {
      cursorRow = digit;
      if (digit < state.question.options.length && state.question.kind === "multiselect") {
        const option = state.question.options[digit];
        if (option !== undefined) {
          toggle(state.selected, option.value);
        }
      }
      return true;
    }
    return false;
  };

  return {
    answers: () => collectAnswers(states),
    frame: () => ({ activeTab, cursorRow, questions: states.map(toView) }),
    handle,
    views: () => states.map(toView),
  };
}

const answerActive = (state: QuestionState, row: number): void => {
  if (state.question.freeText === true && row === state.question.options.length) {
    state.answered = state.text !== "";
    state.answeredWithText = state.answered;
    return;
  }
  if (state.question.kind === "select") {
    const option = state.question.options[row];
    if (option === undefined) {
      return;
    }
    state.selected.clear();
    state.selected.add(option.value);
  }
  state.answered = true;
  state.answeredWithText = false;
};

function collectAnswers(states: readonly QuestionState[]): WizardAnswers {
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

function toView(state: QuestionState): WizardQuestionView {
  return {
    answered: state.answered,
    question: state.question,
    selected: state.answeredWithText ? new Set() : state.selected,
    text: state.text,
  };
}

/** The next unanswered question after `activeTab`, or the Submit tab. */
function nextTab(states: readonly QuestionState[], activeTab: number): number {
  for (let index = activeTab + 1; index < states.length; index += 1) {
    if (states[index]?.answered === false) {
      return index;
    }
  }
  return states.length;
}

function rowCount(question: WizardQuestion): number {
  return question.options.length + (question.freeText === true ? 1 : 0);
}

function toggle(selected: Set<string>, value: string): void {
  if (selected.has(value)) {
    selected.delete(value);
  } else {
    selected.add(value);
  }
}

/** The row a typed digit addresses, counting the free-text row as the last one. */
function digitRow(keypress: Keypress, question: WizardQuestion): number | undefined {
  if (keypress.sequence === undefined || !/^[1-9]$/u.test(keypress.sequence)) {
    return undefined;
  }
  const row = Number(keypress.sequence) - 1;
  return row < rowCount(question) ? row : undefined;
}

function printable(keypress: Keypress): string | undefined {
  if (keypress.ctrl || keypress.meta || keypress.sequence === undefined) {
    return undefined;
  }
  const code = keypress.sequence.codePointAt(0) ?? 0;
  return [...keypress.sequence].length === 1 && code >= 0x20 && code !== 0x7f
    ? keypress.sequence
    : undefined;
}
