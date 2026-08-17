import { safe } from "../safe-text.js";
import type { Style } from "../style.js";
import type { WizardFrame, WizardQuestionView } from "./wizard-render.js";
import type { WizardFlowStep } from "./wizard-types.js";

/** Glyphs shared between the tab bar and the frame bodies; see docs/cli-ux.md. */
export const UNANSWERED = "☐";
export const DONE = "✔";
const ACTIVE = "▶";
const TAB_SEPARATOR = " │ ";
const TOP_ROW_PREFIX = " ";
const SUB_ROW_PREFIX = " └ ";

/** How far the tab bar has degraded to fit the terminal; labels shrink, tabs never hide. */
type TabBarMode = "full" | "compact" | "glyph";

/** One tab of the bar, whatever part of the flow it represents. */
interface TabItem {
  readonly active: boolean;
  /** Step state, or undefined for tabs without a checkbox (Submit and its stand-ins). */
  readonly answered: boolean | undefined;
  readonly compactLabel: string | undefined;
  readonly dimmed: boolean;
  readonly label: string;
}

/**
 * The bar lines mapping the whole flow: one or two rows.
 *
 * With `flow.step` set, the top row is a static map of the real steps — it never mutates while a
 * step's internal forms advance — and the live form's questions render in a `└`-prefixed sub-row
 * framed by the step's chain progress. Without it, the live form's questions splice into the
 * single row at their flow position (legacy forms, and the Submit confirmation whose question
 * stands in for the Submit tab).
 *
 * A row never scrolls or truncates. When full labels overflow the terminal it degrades to
 * compact labels, then to bare state glyphs for the inactive tabs — the active tab always keeps
 * its label, and the question heading below repeats it, so no information is lost.
 */
export function renderTabBar(
  frame: WizardFrame,
  submitLocked: boolean,
  style: Style,
  columns: number,
): readonly string[] {
  const step = frame.flow?.step;
  if (frame.flow === undefined || step === undefined) {
    return [renderRow(splicedItems(frame, submitLocked), style, columns, TOP_ROW_PREFIX)];
  }

  const top = renderRow(
    stepRowItems(frame.flow, step, submitLocked),
    style,
    columns,
    TOP_ROW_PREFIX,
  );
  const sub = subRowItems(frame, step);
  if (sub === undefined) {
    return [top];
  }
  return [top, renderRow(sub, style, columns, SUB_ROW_PREFIX)];
}

/** Fits one row into the terminal and styles its tabs. */
function renderRow(
  items: readonly TabItem[],
  style: Style,
  columns: number,
  prefix: string,
): string {
  const modes: readonly TabBarMode[] = ["full", "compact", "glyph"];
  let tabs = items.map((item) => tabText(item, "glyph"));
  for (const mode of modes) {
    const candidate = items.map((item) => tabText(item, mode));
    if (rowWidth(candidate, prefix) <= columns) {
      tabs = candidate;
      break;
    }
  }

  const rendered = tabs.map((tab, index) => {
    const item = items[index];
    if (item?.active === true) {
      return style.active(tab);
    }
    return item?.dimmed === true ? style.dim(tab) : tab;
  });
  return `${prefix}${rendered.join(TAB_SEPARATOR)}`;
}

/** The legacy single row: the live form's questions inserted at their flow position. */
function splicedItems(frame: WizardFrame, submitLocked: boolean): readonly TabItem[] {
  const flow = frame.flow;
  return [
    ...(flow?.completed ?? []).map((step) => stepTab(step, true)),
    ...frame.questions.map((view, index) =>
      questionTab(view, index === frame.activeTab, flow?.submit === true, false),
    ),
    ...(flow?.upcoming ?? []).map((step) => stepTab(step, false)),
    ...submitTab(frame, submitLocked),
  ];
}

/** The static top row: every real step by name, then Submit. */
function stepRowItems(
  flow: NonNullable<WizardFrame["flow"]>,
  step: WizardFlowStep,
  submitLocked: boolean,
): readonly TabItem[] {
  return [
    ...flow.completed.map((completed) => stepTab(completed, true)),
    {
      active: true,
      answered: false,
      compactLabel: step.compactLabel,
      dimmed: false,
      label: step.label,
    },
    ...flow.upcoming.map((upcoming) => stepTab(upcoming, false)),
    {
      active: false,
      answered: undefined,
      compactLabel: undefined,
      dimmed: submitLocked,
      label: "Submit",
    },
  ];
}

/**
 * The step's internal progress around the live form's questions, or undefined when the form is
 * the step itself: a lone question named like its step needs no second row.
 */
function subRowItems(frame: WizardFrame, step: WizardFlowStep): readonly TabItem[] | undefined {
  const sub = frame.flow?.sub;
  const items = [
    ...(sub?.completed ?? []).map((stage) => ({ ...stepTab(stage, true), dimmed: true })),
    ...frame.questions.map((view, index) => {
      const active = index === frame.activeTab;
      return { ...questionTab(view, active, false, !active) };
    }),
    ...(sub?.upcoming ?? []).map((stage) => ({ ...stepTab(stage, false), dimmed: true })),
  ];
  if (items.length > 1) {
    return items;
  }
  return frame.questions[0]?.question.label === step.label ? undefined : items;
}

function stepTab(step: WizardFlowStep, answered: boolean): TabItem {
  return {
    active: false,
    answered,
    compactLabel: step.compactLabel,
    dimmed: false,
    label: step.label,
  };
}

function questionTab(
  view: WizardQuestionView,
  active: boolean,
  submitStandIn: boolean,
  dimmed: boolean,
): TabItem {
  return {
    active,
    // The Submit form's questions stand in for the Submit tab: an action, no checkbox.
    answered: submitStandIn ? undefined : view.answered,
    compactLabel: view.question.compactLabel,
    dimmed,
    label: view.question.label,
  };
}

function submitTab(frame: WizardFrame, submitLocked: boolean): readonly TabItem[] {
  if (frame.flow?.submit === true) {
    return [];
  }
  const active = frame.flow === undefined && frame.activeTab === frame.questions.length;
  return [
    {
      active,
      answered: undefined,
      compactLabel: undefined,
      dimmed: submitLocked && !active,
      label: "Submit",
    },
  ];
}

function tabText(item: TabItem, mode: TabBarMode): string {
  if (mode === "glyph" && !item.active && item.answered !== undefined) {
    return item.answered ? DONE : UNANSWERED;
  }
  const label = safe(mode === "compact" ? (item.compactLabel ?? item.label) : item.label);
  const state = item.answered === undefined ? label : stateLabel(label, item.answered);
  return item.active ? `${ACTIVE} ${state}` : state;
}

function stateLabel(label: string, answered: boolean): string {
  return answered ? `${DONE} ${label}` : `${label} ${UNANSWERED}`;
}

/** Width of one row as plain text; styling adds only zero-width escape sequences. */
function rowWidth(tabs: readonly string[], prefix: string): number {
  const labels = tabs.reduce((sum, tab) => sum + [...tab].length, 0);
  return [...prefix].length + labels + (tabs.length - 1) * TAB_SEPARATOR.length;
}
