import { safe } from "../safe-text.js";
import type { Style } from "../style.js";
import { queryTerms } from "./wizard-render-search.js";
import { highlightLabel } from "./wizard-search.js";
import { DONE, UNANSWERED } from "./wizard-tabs.js";
import type { WizardOption, WizardQuestion } from "./wizard-types.js";
import type { WizardQuestionView } from "./wizard-render.js";

const ANSWERED = "\u2611";
const CURSOR = "\u276f";
const PARTIAL = "\u25ea";
const SELECTED = "\u25cf";
const UNSELECTED = "\u25cb";

/** Holds an unnumbered row's marker under the numbered ones, where `N. ` would have sat. */
const UNNUMBERED_GUTTER = "   ";

/**
 * The `N. ` a numbered row leads with, or the blank that lines an unnumbered one up under it.
 *
 * One definition for both the option rows and the free-text row below them, so a row that spends
 * no number can never be rendered as one that does.
 */
export function rowGutter(rowNumber: number | undefined): string {
  return rowNumber === undefined ? UNNUMBERED_GUTTER : `${String(rowNumber)}. `;
}

export function groupHeadingLines(
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

export function optionLines(
  option: WizardQuestion["options"][number],
  index: number,
  view: WizardQuestionView,
  cursorRow: number,
  style: Style,
  rowNumber?: number | undefined,
): readonly string[] {
  const cursor = index === cursorRow ? CURSOR : " ";
  const gutter = rowGutter(rowNumber);
  // A select marks what currently stands — the `initial` a fresh form proposes (which is what
  // `--yes` accepts) or a re-seeded answer — since unlike a multiselect it has no checkboxes.
  const marker =
    view.question.kind === "multiselect"
      ? `${multiselectMarker(option, view.selected)} `
      : `${view.selected.has(option.value) ? SELECTED : UNSELECTED} `;
  const unavailable =
    option.disabled === true ? style.dim(` — ${safe(option.disabledNote ?? "unavailable")}`) : "";
  const note = option.note === undefined ? "" : style.dim(` · ${safe(option.note)}`);
  // Sits outside the label so it never lands in a search highlight or an answer summary: it says
  // what Aura would pick, which stops being news the moment the user has picked.
  const advice = option.recommended === true ? style.dim(" (Recommended)") : "";
  const label = highlightLabel(safe(option.label), queryTerms(view), style.bold);
  const rows = [
    `${cursor} ${gutter}${marker}${label}${advice}${note}${memberCount(option, view.selected, style)}${unavailable}`,
  ];
  if (option.description !== undefined) {
    rows.push(style.dim(`      ${safe(option.description)}`));
  }
  return rows;
}

/** A pack row's checkbox carries derived state: none, some (`◪`), or all of its members. */
function multiselectMarker(option: WizardOption, selected: ReadonlySet<string>): string {
  // A locked row is a record, not a question, so it reports `✔` — the same glyph the tab bar
  // spends on what is already settled. An empty box there would invite a space that does nothing.
  if (option.locked === true) {
    return DONE;
  }
  if (option.members === undefined) {
    return selected.has(option.value) ? ANSWERED : UNANSWERED;
  }
  const checked = option.members.filter((value) => selected.has(value)).length;
  if (checked === 0) {
    return UNANSWERED;
  }
  return checked === option.members.length ? ANSWERED : PARTIAL;
}

/** `(K of N selected)` on a partially checked pack row; the marker alone covers none and all. */
function memberCount(option: WizardOption, selected: ReadonlySet<string>, style: Style): string {
  if (option.members === undefined) {
    return "";
  }
  const checked = option.members.filter((value) => selected.has(value)).length;
  if (checked === 0 || checked === option.members.length) {
    return "";
  }
  return style.dim(` (${String(checked)} of ${String(option.members.length)} selected)`);
}
