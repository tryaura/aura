import type { MutableTokenUsage, MutableTurn, ParseState } from "./session-parse-state.js";
import type { SessionTurn } from "./session-detail-metrics.js";
import { boundedAdd, MAX_DURATION_MS, readBoundedInteger } from "./session-numbers.js";

/**
 * Source-agnostic turn folding: the accumulate-and-copy half of turn tracking. Each source parser
 * owns its own turn boundaries (Codex reads explicit task events, Claude Code derives turns from
 * user prompts) but folds tool calls, tool time, and token deltas into turns identically.
 */

/** Turn records retained per session; beyond this the counts stay exact but detail is dropped. */
export const MAX_TURN_DETAILS = 500;

export function addTurnToolCall(state: ParseState, turnIndex: number | undefined): void {
  const turn = turnIndex === undefined ? undefined : state.turnList[turnIndex];
  if (turn !== undefined) {
    turn.toolCalls = boundedAdd(turn.toolCalls, 1);
  }
}

export function addTurnToolTime(
  state: ParseState,
  turnIndex: number | undefined,
  durationMs: number,
): void {
  const turn = turnIndex === undefined ? undefined : state.turnList[turnIndex];
  if (turn !== undefined) {
    turn.toolTimeMs = boundedAdd(turn.toolTimeMs, durationMs);
  }
}

/** Adds one request's token delta to the turn the request was recorded in. */
export function addTurnTokens(
  turn: MutableTurn | undefined,
  delta: Readonly<MutableTokenUsage>,
): void {
  if (turn === undefined) {
    return;
  }
  if (turn.tokens === undefined) {
    turn.tokens = { cachedInputTokens: 0, inputTokens: 0, outputTokens: 0 };
  }
  turn.tokens.cachedInputTokens = boundedAdd(
    turn.tokens.cachedInputTokens,
    delta.cachedInputTokens,
  );
  turn.tokens.inputTokens = boundedAdd(turn.tokens.inputTokens, delta.inputTokens);
  turn.tokens.outputTokens = boundedAdd(turn.tokens.outputTokens, delta.outputTokens);
}

/** Copies the turn accumulators into their public shape, closing a still-open final turn. */
export function finishTurns(state: ParseState): readonly SessionTurn[] {
  closeOpenTurn(state);
  return state.turnList.map((turn) => ({
    closed: turn.closed ?? "log-end",
    durationMs: turn.durationMs ?? spanMs(state, turn),
    endedAt: turn.endedAt,
    index: turn.index,
    model: turn.model,
    startedAt: turn.startedAt,
    timeToFirstTokenMs: turn.timeToFirstTokenMs,
    tokens: turn.tokens === undefined ? undefined : { ...turn.tokens },
    toolCalls: turn.toolCalls,
    toolTimeMs: turn.toolTimeMs,
    turnId: turn.turnId,
  }));
}

/** A crash or cut log leaves a turn open; its span ends at the last record seen. */
export function closeOpenTurn(state: ParseState): void {
  const turn = state.openTurn;
  if (turn === undefined) {
    return;
  }
  turn.closed = "log-end";
  turn.endMs = state.lastMs;
  turn.endedAt = state.endedAt;
  state.openTurn = undefined;
}

function spanMs(state: ParseState, turn: MutableTurn): number {
  if (turn.startMs === undefined || turn.endMs === undefined || turn.endMs < turn.startMs) {
    return 0;
  }
  return readBoundedInteger(state, turn.endMs - turn.startMs, MAX_DURATION_MS) ?? 0;
}
