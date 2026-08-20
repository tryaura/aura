import { printable } from "./wizard-keys.js";
import type { QuestionState } from "./wizard-question.js";
import type { Keypress } from "./wizard-types.js";

/** Gives a searchable question first refusal over keys used to enter, edit, or clear its query. */
export function applySearchKeypress(keypress: Keypress, state: QuestionState | undefined): boolean {
  if (state === undefined) {
    return false;
  }
  if (!state.searching) {
    if (state.question.search === undefined || keypress.sequence !== "/") {
      return false;
    }
    state.searching = true;
    // The two narrowings would fight over the same rows; opening the query is choosing it.
    state.showSelectedOnly = false;
    return true;
  }
  if (keypress.name === "escape") {
    state.searching = false;
    state.searchText = "";
    return true;
  }
  if (keypress.name === "return" || keypress.name === "enter") {
    state.searching = false;
    return true;
  }
  return editSearch(keypress, state);
}

/** Edits the live search field while search mode owns printable keys. */
function editSearch(keypress: Keypress, state: QuestionState): boolean {
  if (keypress.name === "backspace") {
    state.searchText = [...state.searchText].slice(0, -1).join("");
    return true;
  }
  const typed = printable(keypress);
  if (typed === undefined) {
    return false;
  }
  state.searchText += typed;
  return true;
}
