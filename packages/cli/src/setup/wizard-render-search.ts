import { safe } from "../safe-text.js";
import type { Style } from "../style.js";
import type { WizardQuestionView } from "./wizard-render.js";
import { SEARCH_RESULT_CAP, searchTerms } from "./wizard-search.js";

const CURSOR = "\u276f";

export function searchLines(view: WizardQuestionView, style: Style): readonly string[] {
  const search = view.question.search;
  if (search === undefined) {
    return [];
  }
  const chosen = selectedCountSegment(view);
  if (view.showSelectedOnly === true) {
    return [`   s Showing only selected rows · s show all${chosen}`, ""];
  }
  const query = view.searchText ?? "";
  if (view.searching === true) {
    const draft = query === "" ? style.dim(search.placeholder) : safe(query);
    return [` ${CURSOR} / Search: ${draft}${matchCountSegment(view, query)}`, ""];
  }
  if (query !== "") {
    return [`   / Search: ${safe(query)}${matchCountSegment(view, query)}${chosen}`, ""];
  }
  return [`   / ${safe(search.placeholder)}${chosen}`, ""];
}

/** `· N matches`, or `· showing K of N matches` when the render cap dropped a tail. */
function matchCountSegment(view: WizardQuestionView, query: string): string {
  if (query === "") {
    return "";
  }
  const total = view.searchTotal ?? view.question.options.length;
  const shown = Math.min(total, SEARCH_RESULT_CAP);
  if (total > shown) {
    return ` · showing ${String(shown)} of ${String(total)} matches — keep typing to narrow`;
  }
  return ` · ${String(total)} match${total === 1 ? "" : "es"}`;
}

/** `· N selected` on a multiselect with anything checked; silent otherwise. */
function selectedCountSegment(view: WizardQuestionView): string {
  if (view.question.kind !== "multiselect" || view.selected.size === 0) {
    return "";
  }
  return ` · ${String(view.selected.size)} selected`;
}

/** The live query's terms, for bolding matched spans; empty when nothing is being filtered. */
export function queryTerms(view: WizardQuestionView): readonly string[] {
  if (view.question.search === undefined || view.showSelectedOnly === true) {
    return [];
  }
  return searchTerms(view.searchText ?? "");
}
