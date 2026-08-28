import type { ParseState } from "./session-parse-state.js";
import { boundedAdd } from "./session-numbers.js";
import { asRecord, asString } from "./transcript-json.js";
import { collectWorkItems } from "./work-items.js";

/**
 * Shared prompt-text folding. Both sources record message content as either a plain string or an
 * array of typed blocks, and both retain only the initial prompt's size, never its text.
 */

/** The joined `text` fields of a string-or-block-array message content. */
export function contentText(content: unknown): string | undefined {
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

export function recordInitialPrompt(
  state: ParseState,
  text: string | undefined,
  line: number,
): void {
  if (text === undefined || text === "") {
    return;
  }
  state.initialPromptChars = boundedAdd(state.initialPromptChars, text.length);
  state.initialPromptLines.push(line);
  // Scanned while the text is in hand; only extracted keys are retained, never the prompt.
  collectWorkItems(state.workItems, text);
}
