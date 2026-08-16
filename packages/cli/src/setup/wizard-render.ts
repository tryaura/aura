import { safe } from "../render.js";
import type { WizardQuestion } from "./wizard-types.js";

/** One question's live state while its form is on screen. */
export interface WizardQuestionView {
  readonly answered: boolean;
  readonly question: WizardQuestion;
  /** Values currently selected, before or after the question is answered. */
  readonly selected: ReadonlySet<string>;
  /** Draft on the free-text row. */
  readonly text: string;
}

/** Everything one repaint needs; the renderer holds no state of its own. */
export interface WizardFrame {
  /** Index into the tabs: one per question, then the Submit tab. */
  readonly activeTab: number;
  /** Row the cursor is on inside the active question; options first, free text last. */
  readonly cursorRow: number;
  readonly questions: readonly WizardQuestionView[];
}

const UNANSWERED = "☐";
const ANSWERED = "☑";
const CURSOR = "❯";

/**
 * Renders one full wizard frame as plain lines.
 *
 * Pure text in, text out: the engine owns cursor movement and erasing, and tests snapshot these
 * bytes directly. With `colorDepth` 0 the output carries no escape sequences at all, so the same
 * frames are byte-stable under captured streams.
 */
export function renderWizardFrame(frame: WizardFrame, colorDepth: number): string {
  const style = createStyle(colorDepth);
  const lines = [renderTabBar(frame, style), ""];

  const active = frame.questions[frame.activeTab];
  if (active === undefined) {
    lines.push(...renderSubmitBody(frame.questions, style));
  } else {
    lines.push(...renderQuestionBody(active, frame.cursorRow, style));
  }

  lines.push("", style.dim(renderHint(active?.question)));
  return `${lines.join("\n")}\n`;
}

/** One collapsed line per answered question, printed once a form resolves. */
export function renderAnsweredSummary(questions: readonly WizardQuestionView[]): string {
  return `${questions
    .map((view) => ` ${ANSWERED} ${safe(view.question.label)}  ${summarizeAnswer(view)}`)
    .join("\n")}\n`;
}

interface Style {
  readonly active: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
}

function createStyle(colorDepth: number): Style {
  if (colorDepth <= 0) {
    return {
      active: (text) => `[${text}]`,
      bold: (text) => text,
      dim: (text) => text,
    };
  }
  return {
    active: (text) => `\u001b[7m ${text} \u001b[27m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    dim: (text) => `\u001b[2m${text}\u001b[22m`,
  };
}

function renderTabBar(frame: WizardFrame, style: Style): string {
  const tabs = frame.questions.map(
    (view) => `${view.answered ? ANSWERED : UNANSWERED} ${safe(view.question.label)}`,
  );
  tabs.push("✔ Submit");

  const rendered = tabs.map((tab, index) => (index === frame.activeTab ? style.active(tab) : tab));
  return ` ←  ${rendered.join("  ")}  →`;
}

function renderQuestionBody(
  view: WizardQuestionView,
  cursorRow: number,
  style: Style,
): readonly string[] {
  const lines = [` ${style.bold(safe(view.question.prompt))}`, ""];

  view.question.options.forEach((option, index) => {
    const cursor = index === cursorRow ? CURSOR : " ";
    const marker =
      view.question.kind === "multiselect"
        ? `${view.selected.has(option.value) ? ANSWERED : UNANSWERED} `
        : "";
    lines.push(`${cursor} ${String(index + 1)}. ${marker}${safe(option.label)}`);
    if (option.description !== undefined) {
      lines.push(style.dim(`      ${safe(option.description)}`));
    }
  });

  if (view.question.freeText === true) {
    const cursor = cursorRow === view.question.options.length ? CURSOR : " ";
    const draft = view.text === "" ? style.dim("Type something.") : safe(view.text);
    lines.push(`${cursor} ${String(view.question.options.length + 1)}. ${draft}`);
  }

  return lines;
}

function renderSubmitBody(
  questions: readonly WizardQuestionView[],
  style: Style,
): readonly string[] {
  const lines = [` ${style.bold("Review your answers, then press ↵ to continue.")}`, ""];
  for (const view of questions) {
    const box = view.answered ? ANSWERED : UNANSWERED;
    const summary = view.answered ? summarizeAnswer(view) : style.dim("(unanswered)");
    lines.push(` ${box} ${safe(view.question.label)}  ${summary}`);
  }
  return lines;
}

function renderHint(question: WizardQuestion | undefined): string {
  if (question === undefined) {
    return " ↵ submit · ←/→ back to a question · esc cancel";
  }
  const toggle = question.kind === "multiselect" ? " · space toggle" : "";
  return ` ↑/↓ move${toggle} · ←/→ questions · ↵ select · esc cancel`;
}

function summarizeAnswer(view: WizardQuestionView): string {
  if (view.text !== "" && view.answered && view.selected.size === 0) {
    return safe(view.text);
  }
  const labels = view.question.options
    .filter((option) => view.selected.has(option.value))
    .map((option) => safe(option.label));
  return labels.length === 0 ? "(none)" : labels.join(", ");
}
