import { digitRow, rowCount, tabDelta } from "./wizard-keys.js";
import { handlePreviewKeypress, openPreview, type PreviewState } from "./wizard-preview.js";
import {
  answerActive,
  collectAnswers,
  createQuestionState,
  editFreeText,
  initialCursorRow,
  toggleRow,
  toView,
  type QuestionState,
} from "./wizard-question.js";
import type { WizardFrame, WizardQuestionView } from "./wizard-render.js";
import type { Keypress, WizardAnswers, WizardFlowContext, WizardQuestion } from "./wizard-types.js";

/** What one key did to the form. */
type FormEvent = "abort" | "back" | "none" | "repaint" | "submit";

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

export function createFormSession(
  questions: readonly WizardQuestion[],
  flow?: WizardFlowContext,
): FormSession {
  const states: readonly QuestionState[] = questions.map(createQuestionState);
  // With a flow the trailing Submit belongs to the whole wizard, not this form, so the form's
  // navigable tabs are its questions alone and answering the last one resolves it.
  const ownSubmitTab = flow === undefined;
  const tabCount = questions.length + (ownSubmitTab ? 1 : 0);
  let activeTab = 0;
  let cursorRow = initialCursorRow(states[0]);
  let preview: PreviewState | undefined;

  /** ← on the first tab leaves the form for the one before it in the flow. */
  const leavesBackward = (keypress: Keypress): boolean =>
    keypress.name === "left" && activeTab === 0 && canGoBack;

  /**
   * Whether the flow has another form ahead of this one: a later stage of the same step, or a
   * later step.
   *
   * Submit is an action, not a step, so the flow's last form has nothing ahead of it — → stops
   * there rather than committing into the Submit the bar shows after it, the same way → is inert
   * on the Submit form itself. Reaching Submit is always an explicit ↵.
   */
  const hasFormAhead =
    flow !== undefined &&
    flow.submit !== true &&
    ((flow.sub?.upcoming.length ?? 0) > 0 || flow.upcoming.length > 0);

  /**
   * → past the last tab commits the form as it stands and moves on, so a re-entered flow
   * retraces forward without re-answering.
   */
  const commitsForward = (keypress: Keypress): boolean =>
    (keypress.name === "right" || (keypress.name === "tab" && !keypress.shift)) &&
    activeTab === tabCount - 1 &&
    hasFormAhead;

  const handle = (keypress: Keypress): FormEvent => {
    const previewResult = handlePreviewKeypress(preview, keypress);
    if (previewResult !== undefined) {
      preview = previewResult.preview;
      return previewResult.event;
    }
    if (keypress.name === "escape") {
      return "abort";
    }
    if (keypress.name === "return" || keypress.name === "enter") {
      return handleEnter(false);
    }
    if (commitsForward(keypress)) {
      return handleEnter(true);
    }
    if (leavesBackward(keypress)) {
      return "back";
    }
    return applyNavigation(keypress, states[activeTab]) ? "repaint" : "none";
  };

  const handleEnter = (commit: boolean): FormEvent => {
    const state = states[activeTab];
    if (state === undefined) {
      // A locked Submit swallows ↵; the body already lists exactly which steps are missing.
      return states.every((candidate) => candidate.answered) ? "submit" : "none";
    }

    if (commit) {
      commitActive(state);
    } else {
      answerActive(state, cursorRow);
    }
    // A flow form and a one-question form have nothing left to review, so answering the last
    // open question is submitting.
    const allAnswered = states.every((candidate) => candidate.answered);
    if (allAnswered && (!ownSubmitTab || states.length === 1)) {
      return "submit";
    }
    activeTab = ownSubmitTab ? nextTab(states, activeTab) : nextUnanswered(states, activeTab);
    cursorRow = initialCursorRow(states[activeTab]);
    return "repaint";
  };

  /**
   * Answers the question exactly as it stands, without touching its selection.
   *
   * This is what makes → an honest "commit and move on": a re-seeded select keeps the answer it
   * was re-seeded with instead of re-answering with the row under the cursor. Only a select with
   * nothing standing yet falls back to answering like ↵ would.
   */
  const commitActive = (state: QuestionState): void => {
    if (state.question.freeText === true && state.selected.size === 0 && state.text !== "") {
      state.answered = true;
      state.answeredWithText = true;
      return;
    }
    if (state.question.kind === "select" && state.selected.size === 0) {
      answerActive(state, cursorRow);
      return;
    }
    state.answered = true;
    state.answeredWithText = false;
  };

  /** Whether ← past the first tab has somewhere to go: an earlier form of the same flow. */
  const canGoBack =
    flow !== undefined &&
    (flow.completed.length > 0 || flow.submit === true || (flow.sub?.completed.length ?? 0) > 0);

  /** Moves tab focus by one step, stopping at the bar's ends instead of wrapping. */
  const moveTab = (delta: number): boolean => {
    const target = activeTab + delta;
    if (target < 0 || target >= tabCount) {
      return false;
    }
    activeTab = target;
    cursorRow = initialCursorRow(states[target]);
    return true;
  };

  /** Returns true when the key changed the frame. */
  const applyNavigation = (keypress: Keypress, state: QuestionState | undefined): boolean => {
    const delta = tabDelta(keypress);
    if (delta !== undefined) {
      return moveTab(delta);
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
    return onFreeText ? editFreeText(keypress, state) : applyOptionKey(keypress, state);
  };

  const applyOptionKey = (keypress: Keypress, state: QuestionState): boolean => {
    if (keypress.sequence === "p") {
      const option = state.question.options[cursorRow];
      if (option?.preview === undefined || option.disabled === true) {
        return false;
      }
      preview = openPreview(option.preview, option.label);
      return true;
    }
    if (keypress.name === "space") {
      return toggleRow(state, cursorRow);
    }

    const digit = digitRow(keypress, state.question);
    if (digit === undefined) {
      return false;
    }
    cursorRow = digit;
    toggleRow(state, digit);
    return true;
  };

  return {
    answers: () => collectAnswers(states),
    frame: () => ({ activeTab, cursorRow, flow, questions: states.map(toView), preview }),
    handle,
    views: () => states.map(toView),
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

/** The next unanswered question, wrapping past the end; `activeTab` when everything is answered. */
function nextUnanswered(states: readonly QuestionState[], activeTab: number): number {
  for (let offset = 1; offset <= states.length; offset += 1) {
    const index = (activeTab + offset) % states.length;
    if (states[index]?.answered === false) {
      return index;
    }
  }
  return activeTab;
}
