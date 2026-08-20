import { digitRow, moveCursor, tabDelta } from "./wizard-keys.js";
import { applySearchKeypress } from "./wizard-form-search.js";
import { handlePreviewKeypress, openPreview, type PreviewState } from "./wizard-preview.js";
import {
  answerActive,
  collectAnswers,
  createQuestionState,
  editFreeText,
  initialCursorRow,
  markRow,
  toView,
  type QuestionState,
  visibleOptions,
} from "./wizard-question.js";
import type { WizardFrame, WizardQuestionView } from "./wizard-render.js";
import type { Keypress, WizardAnswers, WizardFlowContext, WizardQuestion } from "./wizard-types.js";

/** What one key did to the form. */
type FormEvent = "abort" | "back" | "none" | "repaint" | "submit";

/**
 * The wizard form's state machine, free of any I/O.
 *
 * The prompt engine feeds it keypresses and repaints; tests can drive it directly. All navigation
 * rules live here: ←/→ and tab move between question tabs, ↑/↓ move the cursor, space marks the
 * row without answering, digits jump to a row and mark it, enter answers and advances, and the
 * Submit tab resolves the form once every question is answered.
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
  onAsyncUpdate?: () => void,
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
    const active = states[activeTab];
    if (applySearchKeypress(keypress, active)) {
      cursorRow = 0;
      return "repaint";
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
      answerActive(state, cursorRow, visibleOptions(state));
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
      answerActive(state, cursorRow, visibleOptions(state));
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

    const options = visibleOptions(state);
    if (keypress.name === "up" || keypress.name === "down") {
      cursorRow = moveCursor(state.question, options, cursorRow, keypress.name === "up" ? -1 : 1);
      return true;
    }
    return applyTextOrToggle(keypress, state, options);
  };

  const applyTextOrToggle = (
    keypress: Keypress,
    state: QuestionState,
    options: readonly WizardQuestion["options"][number][],
  ): boolean => {
    const onFreeText = state.question.freeText === true && cursorRow === options.length;
    return onFreeText ? editFreeText(keypress, state) : applyOptionKey(keypress, state, options);
  };

  const applyOptionKey = (
    keypress: Keypress,
    state: QuestionState,
    options: readonly WizardQuestion["options"][number][],
  ): boolean => {
    if (keypress.sequence === "p") {
      return openRowPreview(options);
    }
    if (keypress.sequence === "s") {
      return toggleSelectedFilter(state);
    }
    if (keypress.name === "space") {
      return markRow(state, cursorRow, options);
    }

    const digit = digitRow(keypress, state.question, options);
    if (digit === undefined) {
      return false;
    }
    cursorRow = digit;
    markRow(state, digit, options);
    return true;
  };

  const openRowPreview = (options: readonly WizardQuestion["options"][number][]): boolean => {
    const option = options[cursorRow];
    if (option === undefined || option.disabled === true) {
      return false;
    }
    if (option.preview !== undefined) {
      preview = openPreview(option.preview, option.label);
      return true;
    }
    if (option.loadPreview === undefined) {
      return false;
    }
    const pending = openPreview("Loading the preview…", option.label);
    preview = pending;
    void option.loadPreview().then(
      (content) => {
        replacePendingPreview(pending, content, option.label);
      },
      () => {
        replacePendingPreview(pending, "The preview could not be fetched.", option.label);
      },
    );
    return true;
  };

  /** Swaps the loading notice for the fetched body — unless the reader already closed it. */
  const replacePendingPreview = (pending: PreviewState, content: string, title: string): void => {
    if (preview !== pending) {
      return;
    }
    preview = openPreview(content, title);
    onAsyncUpdate?.();
  };

  /**
   * A review of everything checked, without hunting each row down: `s` narrows a searchable
   * multiselect to its checked rows and back. Inert elsewhere, and while the query has focus `s`
   * still types into it — search takes keys first.
   */
  const toggleSelectedFilter = (state: QuestionState): boolean => {
    if (state.question.search === undefined || state.question.kind !== "multiselect") {
      return false;
    }
    state.showSelectedOnly = !state.showSelectedOnly;
    cursorRow = 0;
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
