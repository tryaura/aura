import { safe, safeMultiline } from "../safe-text.js";
import { createStyle, type Style } from "../style.js";
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

/** A snippet body on screen, and how far into it the reader has scrolled. */
export interface WizardPreview {
  readonly content: string;
  /** First content row to show; clamped here to whatever the viewport can actually hold. */
  readonly offset: number;
  readonly title: string;
}

/** Everything one repaint needs; the renderer holds no state of its own. */
export interface WizardFrame {
  /** Index into the tabs: one per question, then the Submit tab. */
  readonly activeTab: number;
  /** Row the cursor is on inside the active question; options first, free text last. */
  readonly cursorRow: number;
  readonly questions: readonly WizardQuestionView[];
  readonly preview?: WizardPreview | undefined;
}

/** The terminal a frame is being painted into. */
export interface WizardViewport {
  readonly columns: number;
  readonly rows: number;
}

export const DEFAULT_WIZARD_VIEWPORT: WizardViewport = Object.freeze({ columns: 80, rows: 24 });

/** Title, two blank lines, the hint, and a row of headroom for the cursor. */
const PREVIEW_CHROME_ROWS = 5;

/** Below this the wrapped body is unreadable anyway, and the arithmetic stops being useful. */
const PREVIEW_MIN_COLUMNS = 40;

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
export function renderWizardFrame(
  frame: WizardFrame,
  colorDepth: number,
  viewport: WizardViewport = DEFAULT_WIZARD_VIEWPORT,
): string {
  const style = createStyle(colorDepth);
  if (frame.preview !== undefined) {
    return renderPreview(frame.preview, style, viewport);
  }
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

  let previousGroup: string | undefined;
  view.question.options.forEach((option, index) => {
    if (option.group !== undefined && option.group !== previousGroup) {
      if (index > 0) {
        lines.push("");
      }
      lines.push(` ${style.bold(safe(option.group))}`);
      previousGroup = option.group;
    }
    const cursor = index === cursorRow ? CURSOR : " ";
    const marker =
      view.question.kind === "multiselect"
        ? `${view.selected.has(option.value) ? ANSWERED : UNANSWERED} `
        : "";
    const unavailable = option.disabled === true ? style.dim(" — unavailable") : "";
    lines.push(`${cursor} ${String(index + 1)}. ${marker}${safe(option.label)}${unavailable}`);
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
  const preview = question.options.some((option) => option.preview !== undefined)
    ? " · p preview"
    : "";
  return ` ↑/↓ move${toggle}${preview} · ←/→ questions · ↵ select · esc cancel`;
}

/**
 * Shows one screenful of the body, never more.
 *
 * A snippet is plugin-supplied and arbitrarily long, and the engine repaints by moving the cursor
 * up as many rows as it last printed. A frame taller than the terminal scrolls the buffer, that
 * count stops pointing at the frame, and every later repaint lands in the wrong place — so the
 * body is wrapped to the viewport and clipped to it rather than trusted to fit.
 */
function renderPreview(preview: WizardPreview, style: Style, viewport: WizardViewport): string {
  const rows = wrapPreviewLines(preview.content, Math.max(PREVIEW_MIN_COLUMNS, viewport.columns));
  const capacity = Math.max(1, viewport.rows - PREVIEW_CHROME_ROWS);
  const offset = clamp(preview.offset, Math.max(0, rows.length - capacity));
  const visible = rows.slice(offset, offset + capacity);
  const hidden = rows.length - offset - visible.length;
  const more = hidden > 0 ? ` · ${String(hidden)} more line${hidden === 1 ? "" : "s"}` : "";
  const hint = ` ↑/↓ scroll${more} · esc/↵ return to picker`;
  return `${style.bold(safe(preview.title))}\n\n${visible.join("\n")}\n\n${style.dim(hint)}\n`;
}

/** Sanitizes the body and hard-wraps it, so one entry here is exactly one terminal row. */
export function wrapPreviewLines(content: string, columns: number): readonly string[] {
  return safeMultiline(content)
    .split("\n")
    .flatMap((line) => wrapLine(line, columns));
}

function wrapLine(line: string, columns: number): readonly string[] {
  const characters = [...line];
  if (characters.length <= columns) {
    return [line];
  }
  const wrapped: string[] = [];
  for (let index = 0; index < characters.length; index += columns) {
    wrapped.push(characters.slice(index, index + columns).join(""));
  }
  return wrapped;
}

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(value, 0), maximum);
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
