import type { ParseState } from "./session-parse-state.js";
import { addTurnTokens } from "./session-turn-fold.js";
import type { SessionQuota, SessionTokenUsage } from "./session-metrics.js";
import {
  boundedAdd,
  MAX_CONTEXT_WINDOW,
  MAX_QUOTA_WINDOW_MINUTES,
  MAX_TOKEN_COUNT,
  readBoundedInteger,
  readPercentage,
} from "./session-numbers.js";
import { asRecord, asString } from "./transcript-json.js";

/** Folds one `token_count` event into usage, quota, and context metrics. */
export function readTokenUsageEvent(state: ParseState, payload: Record<string, unknown>): void {
  state.tokens = tokenUsage(state, payload) ?? state.tokens;
  state.quota = quotaState(state, payload) ?? state.quota;
  readContextUsage(state, payload);
}

/**
 * Folds one usage record's per-request delta into the context-occupancy observations.
 *
 * Cumulative totals keep growing across compactions, so window occupancy comes from the latest
 * request delta. Its `input_tokens` already includes the cached share.
 */
function readContextUsage(state: ParseState, payload: Record<string, unknown>): void {
  const info = asRecord(payload["info"]);
  if (info === undefined) {
    return;
  }
  state.contextWindow =
    readBoundedInteger(state, info["model_context_window"], MAX_CONTEXT_WINDOW) ??
    state.contextWindow;
  const last = asRecord(info["last_token_usage"]);
  if (last === undefined) {
    return;
  }
  const inputTokens = readBoundedInteger(state, last["input_tokens"], MAX_TOKEN_COUNT) ?? 0;
  const outputTokens = readBoundedInteger(state, last["output_tokens"], MAX_TOKEN_COUNT) ?? 0;
  if (state.initialContextTokens === undefined) {
    state.initialContextTokens = inputTokens;
  }
  const requestTokens =
    readBoundedInteger(state, last["total_tokens"], MAX_TOKEN_COUNT) ??
    boundedAdd(inputTokens, outputTokens);
  state.peakRequestTokens = Math.max(state.peakRequestTokens, requestTokens);
  addTurnTokens(state.openTurn, {
    cachedInputTokens: readBoundedInteger(state, last["cached_input_tokens"], MAX_TOKEN_COUNT) ?? 0,
    inputTokens,
    outputTokens,
  });
}

function quotaState(state: ParseState, payload: Record<string, unknown>): SessionQuota | undefined {
  const limits = asRecord(payload["rate_limits"]);
  const primary = asRecord(limits?.["primary"]);
  const usedPercent = readPercentage(state, primary?.["used_percent"]);
  if (limits === undefined || usedPercent === undefined) {
    return undefined;
  }
  return {
    planType: asString(limits["plan_type"]),
    usedPercent,
    windowMinutes: readBoundedInteger(state, primary?.["window_minutes"], MAX_QUOTA_WINDOW_MINUTES),
  };
}

function tokenUsage(
  state: ParseState,
  payload: Record<string, unknown>,
): SessionTokenUsage | undefined {
  const totals = asRecord(asRecord(payload["info"])?.["total_token_usage"]);
  if (totals === undefined) {
    return undefined;
  }
  return {
    cachedInputTokens:
      readBoundedInteger(state, totals["cached_input_tokens"], MAX_TOKEN_COUNT) ?? 0,
    inputTokens: readBoundedInteger(state, totals["input_tokens"], MAX_TOKEN_COUNT) ?? 0,
    outputTokens: readBoundedInteger(state, totals["output_tokens"], MAX_TOKEN_COUNT) ?? 0,
  };
}
