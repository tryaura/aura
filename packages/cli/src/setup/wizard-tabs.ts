import { safe } from "../safe-text.js";
import type { Style } from "../style.js";
import type { WizardFrame, WizardQuestionView } from "./wizard-render.js";
import type { WizardFlowStep } from "./wizard-types.js";

/** Glyphs shared between the tab bar and the frame bodies; see docs/cli-ux.md. */
export const UNANSWERED = "☐";
export const DONE = "✔";
const ACTIVE = "▶";
const TAB_SEPARATOR = " │ ";

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
 * One line mapping the whole flow: completed steps, the live form's questions inserted at their
 * flow position, the steps still to come, then Submit.
 *
 * The bar never scrolls or truncates. When full labels overflow the terminal it degrades to
 * compact labels, then to bare state glyphs for the inactive tabs — the active tab always keeps
 * its label, and the question heading below repeats it, so no information is lost.
 */
export function renderTabBar(
  frame: WizardFrame,
  submitLocked: boolean,
  style: Style,
  columns: number,
): string {
  const items = tabItems(frame, submitLocked);
  const modes: readonly TabBarMode[] = ["full", "compact", "glyph"];
  let tabs = items.map((item) => tabText(item, "glyph"));
  for (const mode of modes) {
    const candidate = items.map((item) => tabText(item, mode));
    if (barWidth(candidate) <= columns) {
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
  return ` ${rendered.join(TAB_SEPARATOR)}`;
}

function tabItems(frame: WizardFrame, submitLocked: boolean): readonly TabItem[] {
  const flow = frame.flow;
  return [
    ...(flow?.completed ?? []).map((step) => stepTab(step, true)),
    ...frame.questions.map((view, index) =>
      questionTab(view, index === frame.activeTab, flow?.submit === true),
    ),
    ...(flow?.upcoming ?? []).map((step) => stepTab(step, false)),
    ...submitTab(frame, submitLocked),
  ];
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

function questionTab(view: WizardQuestionView, active: boolean, submitStandIn: boolean): TabItem {
  return {
    active,
    // The Submit form's questions stand in for the Submit tab: an action, no checkbox.
    answered: submitStandIn ? undefined : view.answered,
    compactLabel: view.question.compactLabel,
    dimmed: false,
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

/** Width of the bar as plain text; styling adds only zero-width escape sequences. */
function barWidth(tabs: readonly string[]): number {
  const labels = tabs.reduce((sum, tab) => sum + [...tab].length, 0);
  return 1 + labels + (tabs.length - 1) * TAB_SEPARATOR.length;
}
