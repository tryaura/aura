import type { ParseState } from "./codex-parse-state.js";
import { asRecord, asString } from "./transcript-json.js";
import { collectWorkItems } from "./work-items.js";

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
  recordInitialPrompt(state, messageText(payload["content"]), line);
}

export function recordInitialPrompt(
  state: ParseState,
  text: string | undefined,
  line: number,
): void {
  if (text === undefined || text === "") {
    return;
  }
  state.initialPromptChars += text.length;
  state.initialPromptLines.push(line);
  // Scanned while the text is in hand; only extracted keys are retained, never the prompt.
  collectWorkItems(state.workItems, text);
}

function messageText(content: unknown): string | undefined {
  const direct = asString(content);
  if (direct !== undefined) {
    return direct;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts = content.flatMap((part) => {
    const text = asString(asRecord(part)?.["text"]);
    return text === undefined ? [] : [text];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
}
