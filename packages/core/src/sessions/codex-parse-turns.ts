import type { MutableTokenUsage, MutableTurn, ParseState } from "./codex-parse-state.js";
import type { SessionTurn } from "./session-detail-metrics.js";
import { boundedAdd, MAX_DURATION_MS, readBoundedInteger } from "./session-numbers.js";
import { asRecord, asString } from "./transcript-json.js";
import { collectWorkItems } from "./work-items.js";

/**
 * Turn-boundary readers for a Codex rollout: `task_started`, `task_complete`, `turn_aborted`,
 * and the `turn_context` record. Split from `codex-parse-events.ts` only to keep each file
 * within the size cap; the state they fold into is the same parse accumulator.
 */

/** Turn records retained per session; beyond this the counts stay exact but detail is dropped. */
const MAX_TURN_DETAILS = 500;

export function readTaskStarted(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
): void {
  closeOpenTurn(state);
  const index = state.turns;
  state.turns = boundedAdd(state.turns, 1);
  if (index >= MAX_TURN_DETAILS) {
    state.turnsTruncated = true;
    return;
  }
  const turn: MutableTurn = {
    closed: undefined,
    durationMs: undefined,
    endMs: undefined,
    endedAt: undefined,
    index,
    model: state.model,
    startMs: at,
    startedAt: timestamp,
    timeToFirstTokenMs: undefined,
    tokens: undefined,
    toolCalls: 0,
    toolTimeMs: 0,
    turnId: asString(payload["turn_id"]),
  };
  state.turnList.push(turn);
  state.openTurn = turn;
  if (turn.turnId !== undefined) {
    state.turnById.set(turn.turnId, turn);
  }
}

export function readTaskComplete(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
): void {
  state.completedTurns = boundedAdd(state.completedTurns, 1);
  const turn = matchTurn(state, payload);
  if (turn === undefined) {
    return;
  }
  turn.closed = "completed";
  turn.endMs = at;
  turn.endedAt = timestamp;
  turn.durationMs =
    readBoundedInteger(state, payload["duration_ms"], MAX_DURATION_MS) ?? turn.durationMs;
  turn.timeToFirstTokenMs =
    readBoundedInteger(state, payload["time_to_first_token_ms"], MAX_DURATION_MS) ??
    turn.timeToFirstTokenMs;
  if (state.openTurn === turn) {
    state.openTurn = undefined;
  }
}

export function readTurnAborted(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  state.abortedTurns = boundedAdd(state.abortedTurns, 1);
  const turn = matchTurn(state, payload);
  if (turn !== undefined) {
    turn.closed = "aborted";
    turn.endMs = at;
    turn.endedAt = timestamp;
    turn.durationMs =
      readBoundedInteger(state, payload["duration_ms"], MAX_DURATION_MS) ?? turn.durationMs;
    if (state.openTurn === turn) {
      state.openTurn = undefined;
    }
  }
  if (asString(payload["reason"]) === "interrupted") {
    state.interventions.push({ kind: "interrupt", line, turnIndex: turn?.index });
  }
}

/** Folds the model a `turn_context` record names into the session and its matching turn. */
export function readTurnContext(state: ParseState, payload: Record<string, unknown>): void {
  state.recognized += 1;
  const settings = asRecord(asRecord(payload["collaboration_mode"])?.["settings"]);
  const model = asString(payload["model"]) ?? asString(settings?.["model"]);
  if (model === undefined) {
    return;
  }
  state.model = model;
  const turn = matchTurn(state, payload);
  if (turn !== undefined) {
    turn.model = model;
  }
}

/** Folds one recorded patch application into the edit counters. */
export function readPatchApply(state: ParseState, payload: Record<string, unknown>): void {
  if (payload["success"] === false) {
    state.editsFailed = boundedAdd(state.editsFailed, 1);
  } else {
    state.editsApplied = boundedAdd(state.editsApplied, 1);
  }
  const changes = asRecord(payload["changes"]);
  if (changes !== undefined) {
    state.editFiles = boundedAdd(state.editFiles, Object.keys(changes).length);
  }
}

/** Counts one user message, its re-prompt intervention, and any issue keys it names. */
export function readUserMessage(
  state: ParseState,
  payload: Record<string, unknown>,
  line: number,
): void {
  state.userMessages = boundedAdd(state.userMessages, 1);
  recordReprompt(state, line);
  const message = asString(payload["message"]);
  if (message !== undefined) {
    collectWorkItems(state.workItems, message);
  }
}

/** Every user message after the first means a person came back to steer the session. */
function recordReprompt(state: ParseState, line: number): void {
  if (state.userMessages <= 1) {
    return;
  }
  state.interventions.push({
    kind: "reprompt",
    line,
    turnIndex: state.openTurn?.index ?? (state.turns > 0 ? state.turns : undefined),
  });
}

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
function closeOpenTurn(state: ParseState): void {
  const turn = state.openTurn;
  if (turn === undefined) {
    return;
  }
  turn.closed = "log-end";
  turn.endMs = state.lastMs;
  turn.endedAt = state.endedAt;
  state.openTurn = undefined;
}

/** Codex turns do not overlap, so the open turn is the safe fallback when ids are absent. */
function matchTurn(state: ParseState, payload: Record<string, unknown>): MutableTurn | undefined {
  const turnId = asString(payload["turn_id"]);
  const byId = turnId === undefined ? undefined : state.turnById.get(turnId);
  return byId ?? state.openTurn;
}

function spanMs(state: ParseState, turn: MutableTurn): number {
  if (turn.startMs === undefined || turn.endMs === undefined || turn.endMs < turn.startMs) {
    return 0;
  }
  return readBoundedInteger(state, turn.endMs - turn.startMs, MAX_DURATION_MS) ?? 0;
}
