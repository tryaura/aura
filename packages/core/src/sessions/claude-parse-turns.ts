import type { ClaudeParseState } from "./claude-parse-state.js";
import type { MutableTurn } from "./session-parse-state.js";
import { recordInitialPrompt } from "./session-prompt.js";
import { boundedAdd } from "./session-numbers.js";
import { MAX_TURN_DETAILS } from "./session-turn-fold.js";
import { collectWorkItems } from "./work-items.js";

/**
 * Turn derivation for a Claude Code transcript. The log has no explicit turn events: a turn opens
 * at each user prompt and closes at the next prompt or at log end, completed when the last
 * recorded `stop_reason` says the model finished rather than the log just stopping.
 */

/** The marker Claude Code writes as the user text when a person cuts a turn short. */
const INTERRUPT_PREFIX = "[Request interrupted by user";

export function isInterruptMarker(text: string | undefined): boolean {
  return text !== undefined && text.startsWith(INTERRUPT_PREFIX);
}

/** A person cut the open turn short: close it aborted and record the intervention. */
export function readClaudeInterrupt(
  state: ClaudeParseState,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  state.abortedTurns = boundedAdd(state.abortedTurns, 1);
  const turn = state.openTurn;
  if (turn !== undefined) {
    turn.closed = "aborted";
    turn.endMs = at;
    turn.endedAt = timestamp;
    state.openTurn = undefined;
  }
  state.activeTurn = false;
  state.lastStopReason = undefined;
  state.interventions.push({ kind: "interrupt", line, turnIndex: turn?.index });
}

/**
 * Closes the turn the next prompt (or log end) supersedes.
 *
 * `end_turn`/`stop_sequence` on the turn's last request means the model finished; anything else —
 * a cut stream, an API error, a stop the log never recorded — leaves the close at `log-end`, the
 * shared "the records just stop" verdict.
 */
export function closeClaudeTurn(state: ClaudeParseState): void {
  const completed = state.lastStopReason === "end_turn" || state.lastStopReason === "stop_sequence";
  if (state.activeTurn && completed) {
    state.completedTurns = boundedAdd(state.completedTurns, 1);
  }
  const turn = state.openTurn;
  if (turn !== undefined) {
    turn.closed = completed ? "completed" : undefined;
    turn.endMs = state.lastMs;
    turn.endedAt = state.endedAt;
    state.openTurn = undefined;
  }
  state.activeTurn = false;
  state.lastStopReason = undefined;
}

/** One prompt record opens one turn; every source of prompts (typed, queued, sdk) counts. */
export function openClaudeTurn(
  state: ClaudeParseState,
  promptSource: string,
  text: string | undefined,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  closeClaudeTurn(state);
  state.activeTurn = true;
  const index = state.turns;
  state.turns = boundedAdd(state.turns, 1);
  if (index >= MAX_TURN_DETAILS) {
    state.turnsTruncated = true;
  } else {
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
      turnId: undefined,
    };
    state.turnList.push(turn);
    state.openTurn = turn;
  }
  recordClaudePromptText(state, promptSource, text, line);
}

/** Only prompts a person sent count as user messages; only typed ones can be reprompts. */
function recordClaudePromptText(
  state: ClaudeParseState,
  promptSource: string,
  text: string | undefined,
  line: number,
): void {
  if (promptSource === "typed" || promptSource === "queued") {
    state.userMessages = boundedAdd(state.userMessages, 1);
  }
  if (promptSource === "typed") {
    state.typedPrompts = boundedAdd(state.typedPrompts, 1);
    if (state.typedPrompts === 1) {
      recordInitialPrompt(state, text, line);
      return;
    }
    state.interventions.push({
      kind: "reprompt",
      line,
      turnIndex: state.openTurn?.index ?? (state.turns > 0 ? state.turns : undefined),
    });
  }
  if (text !== undefined) {
    collectWorkItems(state.workItems, text);
  }
}
