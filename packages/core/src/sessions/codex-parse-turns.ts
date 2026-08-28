import type { MutableTurn, ParseState } from "./session-parse-state.js";
import { closeOpenTurn, MAX_TURN_DETAILS } from "./session-turn-fold.js";
import { boundedAdd, MAX_DURATION_MS, readBoundedInteger } from "./session-numbers.js";
import { asRecord, asString } from "./transcript-json.js";
import { collectWorkItems } from "./work-items.js";

/**
 * Turn-boundary readers for a Codex rollout: `task_started`, `task_complete`, `turn_aborted`,
 * and the `turn_context` record. Split from `codex-parse-events.ts` only to keep each file
 * within the size cap; the state they fold into is the same parse accumulator.
 */

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

/** Codex turns do not overlap, so the open turn is the safe fallback when ids are absent. */
function matchTurn(state: ParseState, payload: Record<string, unknown>): MutableTurn | undefined {
  const turnId = asString(payload["turn_id"]);
  const byId = turnId === undefined ? undefined : state.turnById.get(turnId);
  return byId ?? state.openTurn;
}
