import { safe } from "../safe-text.js";
import { createStyle, type Style } from "../style.js";
import { wrapPreviewLines } from "../text-width.js";
import { clipBody } from "./wizard-clip.js";
import { highlightLabel } from "./wizard-search.js";
import { queryTerms, searchLines } from "./wizard-render-search.js";
import { DONE, renderTabBar, UNANSWERED } from "./wizard-tabs.js";
import type { WizardFlowContext, WizardOption, WizardQuestion } from "./wizard-types.js";

/** One question's live state while its form is on screen. */
export interface WizardQuestionView {
  /** The unfiltered option set, used to summarize hidden selections after submission. */
  readonly allOptions?: readonly WizardOption[] | undefined;
  readonly answered: boolean;
  readonly question: WizardQuestion;
  /** Whether printable keys currently belong to the search field. */
  readonly searching?: boolean | undefined;
  /** How many rows the live query matched before the render cap, for the search status line. */
  readonly searchTotal?: number | undefined;
  /** The live local search query. */
  readonly searchText?: string | undefined;
  /** Values currently selected, before or after the question is answered. */
  readonly selected: ReadonlySet<string>;
  /** Whether the `s` filter is narrowing the rows to the checked ones. */
  readonly showSelectedOnly?: boolean | undefined;
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
  /** Index into the form's own tabs: one per question, then the Submit tab when it has one. */
  readonly activeTab: number;
  /** Row the cursor is on inside the active question; options first, free text last. */
  readonly cursorRow: number;
  /** The surrounding wizard flow rendered around the form's questions; see the type's docs. */
  readonly flow?: WizardFlowContext | undefined;
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

/** Two blank lines, the hint, and a row of headroom — plus one row per tab-bar line. */
const FRAME_BASE_CHROME_ROWS = 4;

/** Below this the wrapped body is unreadable anyway, and the arithmetic stops being useful. */
const PREVIEW_MIN_COLUMNS = 40;

const ANSWERED = "☑";
const CURSOR = "❯";
const SELECTED = "●";
const UNSELECTED = "○";

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
  const style = createWizardStyle(colorDepth);
  if (frame.preview !== undefined) {
    return renderPreview(frame.preview, style, viewport);
  }
  // A form inside a flow can never unlock the flow's Submit by itself: later steps still pend.
  const submitLocked = frame.flow !== undefined || frame.questions.some((view) => !view.answered);
  const barLines = renderTabBar(frame, submitLocked, style, viewport.columns);
  const lines = [...barLines, ""];

  const active = frame.questions[frame.activeTab];
  const body =
    active === undefined
      ? { focus: 0, lines: renderSubmitBody(frame.questions, submitLocked, style) }
      : renderQuestionBody(active, frame.cursorRow, style);
  // The engine repaints by moving the cursor up as many rows as it last printed; a frame taller
  // than the terminal scrolls the buffer and the erasure lands short, leaking rows into the
  // scrollback. The body is therefore windowed around the cursor instead of trusted to fit.
  lines.push(
    ...clipBody(
      body.lines,
      body.focus,
      viewport.rows - FRAME_BASE_CHROME_ROWS - barLines.length,
      style,
      viewport.columns,
    ),
  );

  lines.push("", style.dim(renderHint(active?.question, submitLocked, active?.searching === true)));
  return `${lines.join("\n")}\n`;
}

/** Base styling plus the inverse-video marker only the wizard's tab bar applies. */
export interface WizardStyle extends Style {
  /**
   * The `▶` arrow already marks the active tab, so this must not add visible-width markers: the
   * tab-bar width arithmetic counts glyph columns only, and styling has to stay zero-width.
   */
  readonly active: (text: string) => string;
}

export function createWizardStyle(colorDepth: number): WizardStyle {
  const style = createStyle(colorDepth);
  return {
    ...style,
    active: colorDepth <= 0 ? (text) => text : (text) => `\u001b[7m${text}\u001b[27m`,
  };
}

/** One collapsed line per answered question, printed once a form resolves. */
export function renderAnsweredSummary(questions: readonly WizardQuestionView[]): string {
  return `${questions
    .map((view) => ` ${DONE} ${safe(view.question.label)}  ${summarizeAnswer(view)}`)
    .join("\n")}\n`;
}

function renderQuestionBody(
  view: WizardQuestionView,
  cursorRow: number,
  style: Style,
): { readonly focus: number; readonly lines: readonly string[] } {
  const lines = [` ${style.bold(safe(view.question.prompt))}`, ""];
  let focus = 0;

  lines.push(...searchLines(view, style));

  let previousGroup: string | undefined;
  view.question.options.forEach((option, index) => {
    lines.push(...groupHeadingLines(option.group, index, previousGroup, style));
    previousGroup = option.group ?? previousGroup;
    if (index === cursorRow) {
      focus = lines.length;
    }
    lines.push(...optionLines(option, index, view, cursorRow, style));
  });

  if (view.question.search !== undefined && view.question.options.length === 0) {
    focus = lines.length;
    lines.push(style.dim("   No matching options."));
  }

  if (view.question.freeText === true) {
    const onFreeText = cursorRow === view.question.options.length;
    const cursor = onFreeText ? CURSOR : " ";
    if (onFreeText) {
      focus = lines.length;
    }
    const draft = view.text === "" ? style.dim("Type something.") : safe(view.text);
    lines.push(`${cursor} ${String(view.question.options.length + 1)}. ${draft}`);
  }

  return { focus, lines };
}

function groupHeadingLines(
  group: string | undefined,
  index: number,
  previousGroup: string | undefined,
  style: Style,
): readonly string[] {
  if (group === undefined || group === previousGroup) {
    return [];
  }
  return [...(index > 0 ? [""] : []), ` ${style.bold(safe(group))}`];
}

function optionLines(
  option: WizardQuestion["options"][number],
  index: number,
  view: WizardQuestionView,
  cursorRow: number,
  style: Style,
): readonly string[] {
  const cursor = index === cursorRow ? CURSOR : " ";
  // A select marks what currently stands — the `initial` a fresh form proposes (which is what
  // `--yes` accepts) or a re-seeded answer — since unlike a multiselect it has no checkboxes.
  const marker =
    view.question.kind === "multiselect"
      ? `${view.selected.has(option.value) ? ANSWERED : UNANSWERED} `
      : `${view.selected.has(option.value) ? SELECTED : UNSELECTED} `;
  const unavailable =
    option.disabled === true ? style.dim(` — ${safe(option.disabledNote ?? "unavailable")}`) : "";
  const label = highlightLabel(safe(option.label), queryTerms(view), style.bold);
  const rows = [`${cursor} ${String(index + 1)}. ${marker}${label}${unavailable}`];
  if (option.description !== undefined) {
    rows.push(style.dim(`      ${safe(option.description)}`));
  }
  return rows;
}

function renderSubmitBody(
  questions: readonly WizardQuestionView[],
  submitLocked: boolean,
  style: Style,
): readonly string[] {
  const heading = submitLocked
    ? "Submit unlocks once every step below is answered."
    : "Review your answers, then press ↵ to continue.";
  const lines = [` ${style.bold(heading)}`, ""];
  for (const view of questions) {
    const box = view.answered ? DONE : UNANSWERED;
    const summary = view.answered ? summarizeAnswer(view) : style.dim("(unanswered)");
    lines.push(` ${box} ${safe(view.question.label)}  ${summary}`);
  }
  return lines;
}

function renderHint(
  question: WizardQuestion | undefined,
  submitLocked: boolean,
  searching: boolean,
): string {
  if (question === undefined) {
    return submitLocked ? " ←/→ steps · esc cancel" : " ↵ submit · ←/→ steps · esc cancel";
  }
  // While the query has focus the two keys the hint leads with mean something else: ↵ hands focus
  // back to the rows and esc clears the query instead of cancelling the form. Naming the standing
  // bindings here would be naming the wrong ones.
  if (searching) {
    return " type to filter · ↑/↓ move · ↵ results · esc clear search";
  }
  return standingHint(question);
}

/** The default binding hint; segments appear only where the key would do something. */
function standingHint(question: WizardQuestion): string {
  // Space only marks the row, so ↵ is what commits and moves on — a select names the two apart
  // rather than calling both "select".
  const multi = question.kind === "multiselect";
  const mark = multi ? " · space toggle" : " · space select";
  const commit = multi ? "↵ select" : "↵ confirm";
  const preview = question.options.some(
    (option) => option.preview !== undefined || option.loadPreview !== undefined,
  )
    ? " · p preview"
    : "";
  const search = question.search === undefined ? "" : " · / search";
  const selectedFilter = question.search !== undefined && multi ? " · s selected" : "";
  return ` ↑/↓ move${mark}${preview}${search}${selectedFilter} · ←/→ steps · ${commit} · esc cancel`;
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

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(value, 0), maximum);
}

function summarizeAnswer(view: WizardQuestionView): string {
  if (view.text !== "" && view.answered && view.selected.size === 0) {
    return safe(view.text);
  }
  const labels = (view.allOptions ?? view.question.options)
    .filter((option) => view.selected.has(option.value))
    .map((option) => safe(option.label));
  return labels.length === 0 ? "(none)" : labels.join(", ");
}
