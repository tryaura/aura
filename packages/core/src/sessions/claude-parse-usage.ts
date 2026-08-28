import type { ClaudeParseState } from "./claude-parse-state.js";
import { boundedAdd, MAX_TOKEN_COUNT, readBoundedInteger } from "./session-numbers.js";
import { addTurnTokens } from "./session-turn-fold.js";
import { asRecord, asString } from "./transcript-json.js";

/**
 * Token accounting for Claude Code assistant records.
 *
 * A streamed assistant turn is written as several JSONL lines that share one `message.id` and
 * repeat the identical usage object, so usage counts once per message id, never per line. The
 * model's context window is not recorded anywhere in the transcript, so occupancy metrics carry
 * request sizes only and the window itself stays unknown.
 */

/** Records the model and, once per message, the request's token usage. */
export function readClaudeUsage(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): void {
  const model = asString(message["model"]);
  const synthetic = model === "<synthetic>" || record["isApiErrorMessage"] === true;
  if (model !== undefined && !synthetic) {
    state.model = model;
    if (state.openTurn !== undefined) {
      state.openTurn.model = model;
    }
  }
  if (synthetic) {
    return;
  }
  const stopReason = asString(message["stop_reason"]);
  if (stopReason !== undefined) {
    state.lastStopReason = stopReason;
  }
  readMessageUsage(state, record, message);
}

function readMessageUsage(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): void {
  const usage = asRecord(message["usage"]);
  if (usage === undefined || !firstSightOfMessage(state, record, message)) {
    return;
  }
  const cacheRead = usageTokens(state, usage, "cache_read_input_tokens");
  const cacheCreation = usageTokens(state, usage, "cache_creation_input_tokens");
  const uncached = usageTokens(state, usage, "input_tokens");
  const outputTokens = usageTokens(state, usage, "output_tokens");
  // Matches the Codex meaning of `inputTokens`: the full prompt, cached share included.
  const inputTokens = boundedAdd(boundedAdd(uncached, cacheRead), cacheCreation);
  accumulateTokens(state, cacheRead, inputTokens, outputTokens);
  addTurnTokens(state.openTurn, { cachedInputTokens: cacheRead, inputTokens, outputTokens });
}

/** Whether this line is the message's first sighting; unidentifiable lines each count once. */
function firstSightOfMessage(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): boolean {
  const id = asString(message["id"]) ?? asString(record["requestId"]);
  if (id === undefined) {
    return true;
  }
  if (state.seenMessageIds.has(id)) {
    return false;
  }
  state.seenMessageIds.add(id);
  return true;
}

function usageTokens(
  state: ClaudeParseState,
  usage: Record<string, unknown>,
  field: string,
): number {
  return readBoundedInteger(state, usage[field], MAX_TOKEN_COUNT) ?? 0;
}

function accumulateTokens(
  state: ClaudeParseState,
  cacheRead: number,
  inputTokens: number,
  outputTokens: number,
): void {
  state.tokens = {
    cachedInputTokens: boundedAdd(state.tokens?.cachedInputTokens ?? 0, cacheRead),
    inputTokens: boundedAdd(state.tokens?.inputTokens ?? 0, inputTokens),
    outputTokens: boundedAdd(state.tokens?.outputTokens ?? 0, outputTokens),
  };
  if (state.initialContextTokens === undefined) {
    state.initialContextTokens = inputTokens;
  }
  state.peakRequestTokens = Math.max(
    state.peakRequestTokens,
    boundedAdd(inputTokens, outputTokens),
  );
}
