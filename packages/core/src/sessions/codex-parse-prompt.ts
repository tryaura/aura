import type { ParseState } from "./session-parse-state.js";
import { contentText, recordInitialPrompt } from "./session-prompt.js";
import { asString } from "./transcript-json.js";

/**
 * Initial-prompt accumulation for a Codex rollout. Split from `codex-parse.ts` only to keep each
 * file within the size cap; the state it folds into is the same parse accumulator.
 */

/** Counts a system/developer/user message toward the initial prompt while it is still open. */
export function recordPromptMessage(
  state: ParseState,
  payload: Record<string, unknown>,
  kind: string | undefined,
  line: number,
): void {
  if (kind !== "message" || !state.promptOpen) {
    return;
  }
  const role = asString(payload["role"]);
  if (role !== "developer" && role !== "system" && role !== "user") {
    return;
  }
  recordInitialPrompt(state, contentText(payload["content"]), line);
}
