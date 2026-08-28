import { finishCalls } from "./session-call-fold.js";
import {
  finishCommands,
  finishContext,
  finishEdits,
  finishValidation,
  sumToolTime,
  type ParseState,
} from "./session-parse-state.js";
import type { SessionSource } from "./session-detail-metrics.js";
import type { AgentSessionMetrics } from "./session-metrics.js";
import { boundedSum, MAX_DURATION_MS } from "./session-numbers.js";
import { inferSessionOutcome } from "./session-outcome-infer.js";
import { finishTurns } from "./session-turn-fold.js";
import { collectWorkItems } from "./work-items.js";

/** Copies one finished parse accumulator into the public per-session result shape. */
export function finishSessionMetrics(
  state: ParseState,
  source: SessionSource,
  truncated: boolean,
  readError: boolean,
): AgentSessionMetrics {
  const turnDetails = finishTurns(state);
  const calls = finishCalls(state);
  if (state.git.branch !== undefined) {
    collectWorkItems(state.workItems, state.git.branch);
  }
  const pullRequests = [...state.pullRequests];
  // Computed before the literal below: a rejected span must land in `invalidValues`/`partial`.
  const wallClockMs = sessionWallClock(state);
  return {
    agentTimeMs: boundedSum(turnDetails.map((turn) => turn.durationMs)),
    abortedTurns: state.abortedTurns,
    ...(calls === undefined ? {} : { calls }),
    commands: finishCommands(state.commands),
    compactions: state.compactions,
    completedTurns: state.completedTurns,
    context: finishContext(state),
    cwd: state.cwd,
    edits: finishEdits(state),
    endedAt: state.endedAt,
    git: state.git,
    inferredOutcome: inferSessionOutcome(
      turnDetails,
      state.interventions.length,
      pullRequests.length,
    ),
    initialPromptChars: state.initialPromptChars,
    initialPromptLines: state.initialPromptLines,
    invalidValues: state.invalidValues,
    interventions: state.interventions,
    largestToolOutputChars: state.largestToolOutputChars,
    model: state.model,
    malformedLines: state.malformedLines,
    outcomes: state.outcomes,
    pullRequests,
    ...(state.quota === undefined ? {} : { quota: state.quota }),
    sessionId: state.sessionId,
    source,
    startedAt: state.startedAt,
    tokens: state.tokens,
    toolTimeMs: sumToolTime(state.tools),
    toolOutputChars: state.toolOutputChars,
    tools: Object.fromEntries(
      [...state.tools.entries()].map(([tool, used]) => [tool, { ...used }]),
    ),
    partial: truncated || readError || state.invalidValues > 0 || state.malformedLines > 0,
    readError,
    truncated,
    turnDetails,
    turns: state.turns,
    turnsTruncated: state.turnsTruncated,
    userMessages: state.userMessages,
    validation: finishValidation(state),
    wallClockMs,
    workItems: [...state.workItems],
  };
}

function sessionWallClock(state: ParseState): number {
  if (state.firstMs === undefined || state.lastMs === undefined || state.lastMs < state.firstMs) {
    return 0;
  }
  const elapsed = state.lastMs - state.firstMs;
  if (!Number.isSafeInteger(elapsed) || elapsed > MAX_DURATION_MS) {
    state.invalidValues += 1;
    return 0;
  }
  return elapsed;
}
