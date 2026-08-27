import { readEvent } from "./codex-parse-events.js";
import { createParseState } from "./codex-parse-initialize.js";
import { recordInitialPrompt, recordPromptMessage } from "./codex-parse-prompt.js";
import { finishCalls, readToolCall, readToolResult } from "./codex-parse-tools.js";
import { finishTurns, readTurnContext } from "./codex-parse-turns.js";
import {
  finishCommands,
  finishContext,
  finishEdits,
  finishValidation,
  sumToolTime,
  type ParseState,
} from "./codex-parse-state.js";
import { utcTimestampMs } from "./iso-time.js";
import type { SessionDetailLevel } from "./session-detail-metrics.js";
import type { AgentSessionMetrics } from "./session-metrics.js";
import { boundedAdd, boundedSum, MAX_DURATION_MS } from "./session-numbers.js";
import { inferSessionOutcome } from "./session-outcome-infer.js";
import { sanitizeRepositoryUrl } from "./project-resolve.js";
import { asRecord, asString, parseTranscriptRecord } from "./transcript-json.js";
import { collectWorkItems } from "./work-items.js";

export type CodexSessionParseResult =
  | { readonly kind: "excluded" }
  | { readonly kind: "session"; readonly session: AgentSessionMetrics }
  | { readonly kind: "unrecognized" };

/**
 * Extracts {@link AgentSessionMetrics} from one Codex rollout transcript.
 *
 * A rollout file is a line-delimited JSON log of `{timestamp, type, payload}` records. The format
 * is Codex's private state, so every read here is defensive: a line that fails to parse or a
 * record missing an expected field is skipped, never fatal. Malformed records and rejected numeric
 * values are counted so consumers can distinguish exact metrics from lower bounds.
 */

export function parseCodexSession(
  content: string,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
): AgentSessionMetrics | undefined {
  const state = createParseState(detail);
  readLines(state, content, truncated);
  const result = finishSession(state, truncated);
  return result.kind === "session" ? result.session : undefined;
}

export function parseCodexSessionResult(
  content: string,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
  readError = false,
): CodexSessionParseResult {
  const state = createParseState(detail);
  readLines(state, content, truncated);
  return finishSession(state, truncated, readError);
}

export async function parseCodexSessionLinesResult(
  lines: AsyncIterable<string>,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
  completed?: (() => boolean) | undefined,
): Promise<CodexSessionParseResult> {
  const state = createParseState(detail);
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    readLine(state, line, lineNumber);
  }
  return finishSession(state, truncated, completed?.() === false);
}

function finishSession(
  state: ParseState,
  truncated: boolean,
  readError = false,
): CodexSessionParseResult {
  if (state.internalApprovalReview) {
    return { kind: "excluded" };
  }
  if (state.recognized === 0) {
    return { kind: "unrecognized" };
  }
  const turnDetails = finishTurns(state);
  const calls = finishCalls(state);
  if (state.git.branch !== undefined) {
    collectWorkItems(state.workItems, state.git.branch);
  }
  const pullRequests = [...state.pullRequests];
  const wallClockMs = sessionWallClock(state);
  return {
    kind: "session",
    session: {
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
      source: "codex",
      startedAt: state.startedAt,
      tokens: state.tokens,
      toolTimeMs: sumToolTime(state.tools),
      toolOutputChars: state.toolOutputChars,
      tools: Object.fromEntries(
        [...state.tools.entries()].map(([tool, usage]) => [tool, { ...usage }]),
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
    },
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

/** Parses one line at a time without allocating an array proportional to the transcript. */
function readLines(state: ParseState, content: string, truncated: boolean): void {
  let lineNumber = 0;
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const finalLine = newline === -1;
    if (finalLine && truncated) {
      return;
    }
    lineNumber += 1;
    const line = content.slice(start, finalLine ? content.length : newline);
    readLine(state, line, lineNumber);
    if (finalLine) {
      return;
    }
    start = newline + 1;
  }
}

function readLine(state: ParseState, line: string, lineNumber: number): void {
  if (line.trim() === "") {
    return;
  }
  const record = parseTranscriptRecord(line);
  if (record !== undefined) {
    readRecord(state, record, lineNumber);
  } else {
    state.malformedLines += 1;
  }
}

function readRecord(state: ParseState, record: Record<string, unknown>, line: number): void {
  const timestamp = asString(record["timestamp"]);
  const at = trackRecordTime(state, timestamp);
  const type = asString(record["type"]);
  if (type === "compacted") {
    state.recognized += 1;
    state.compactions = boundedAdd(state.compactions, 1);
    return;
  }
  const payload = asRecord(record["payload"]);
  if (payload === undefined) {
    return;
  }
  if (type === "session_meta") {
    readSessionMeta(state, payload, line);
  } else if (type === "response_item") {
    readResponseItem(state, payload, timestamp, at, line);
  } else if (type === "event_msg") {
    readEvent(state, payload, timestamp, at, line);
  } else if (type === "turn_context") {
    readTurnContext(state, payload);
  }
}

/** Folds the record's timestamp into the session's span and returns it as epoch milliseconds. */
function trackRecordTime(state: ParseState, timestamp: string | undefined): number | undefined {
  const at = timestamp === undefined ? undefined : utcTimestampMs(timestamp);
  if (at === undefined || timestamp === undefined) {
    return undefined;
  }
  if (state.firstMs === undefined || at < state.firstMs) {
    state.firstMs = at;
    state.startedAt = timestamp;
  }
  if (state.lastMs === undefined || at > state.lastMs) {
    state.lastMs = at;
    state.endedAt = timestamp;
  }
  return at;
}

function readSessionMeta(state: ParseState, payload: Record<string, unknown>, line: number): void {
  state.recognized += 1;
  const source = asRecord(payload["source"]);
  const subagent = asRecord(source?.["subagent"]);
  if (
    asString(payload["thread_source"]) === "subagent" &&
    asString(subagent?.["other"]) === "guardian"
  ) {
    state.internalApprovalReview = true;
  }
  state.sessionId = asString(payload["id"]) ?? state.sessionId;
  state.cwd = asString(payload["cwd"]) ?? state.cwd;
  state.git = sessionGitContext(payload, state.git);
  const baseInstructions = asRecord(payload["base_instructions"]);
  recordInitialPrompt(state, asString(baseInstructions?.["text"]), line);
}

function sessionGitContext(
  payload: Record<string, unknown>,
  fallback: AgentSessionMetrics["git"],
): AgentSessionMetrics["git"] {
  const git = asRecord(payload["git"]);
  return {
    branch: asString(git?.["branch"]) ?? fallback.branch,
    commitHash: asString(git?.["commit_hash"]) ?? fallback.commitHash,
    repositoryUrl:
      sanitizeRepositoryUrl(asString(git?.["repository_url"]) ?? "") ?? fallback.repositoryUrl,
  };
}

function readResponseItem(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  const kind = asString(payload["type"]);
  recordPromptMessage(state, payload, kind, line);
  if (kind === "function_call" || kind === "custom_tool_call") {
    state.recognized += 1;
    readToolCall(state, payload, timestamp, at, line);
  } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
    state.recognized += 1;
    readToolResult(state, payload, at, line);
  }
}
