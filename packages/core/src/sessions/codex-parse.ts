import { readEvent } from "./codex-parse-events.js";
import { readToolCall, readToolResult } from "./codex-parse-tools.js";
import { sumToolTime, type ParseState } from "./codex-parse-state.js";
import { utcTimestampMs } from "./iso-time.js";
import type { AgentSessionMetrics } from "./session-metrics.js";
import { asRecord, asString, parseTranscriptRecord } from "./transcript-json.js";

/**
 * Extracts {@link AgentSessionMetrics} from one Codex rollout transcript.
 *
 * A rollout file is a line-delimited JSON log of `{timestamp, type, payload}` records. The format
 * is Codex's private state, so every read here is defensive: a line that fails to parse or a
 * record missing an expected field is skipped, never fatal. Counts are exact for what the file
 * carries and lower bounds for what it does not.
 */

/** Metrics for the transcript, or undefined when no line looked like a Codex session record. */
export function parseCodexSession(
  content: string,
  truncated: boolean,
): AgentSessionMetrics | undefined {
  const state = initialState();
  readLines(state, content, truncated);
  return finishSession(state, truncated);
}

/** Streaming counterpart used by the production filesystem boundary. */
export async function parseCodexSessionLines(
  lines: AsyncIterable<string>,
  truncated: boolean,
): Promise<AgentSessionMetrics | undefined> {
  const state = initialState();
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    readLine(state, line, lineNumber);
  }
  return finishSession(state, truncated);
}

function initialState(): ParseState {
  return {
    compactions: 0,
    cwd: undefined,
    endedAt: undefined,
    firstMs: undefined,
    git: { branch: undefined, commitHash: undefined, repositoryUrl: undefined },
    initialPromptChars: 0,
    initialPromptLines: [],
    largestToolOutputChars: 0,
    lastMs: undefined,
    outcomes: [],
    pending: new Map(),
    promptOpen: true,
    quota: undefined,
    recognized: 0,
    sessionId: undefined,
    shellSessions: new Map(),
    startedAt: undefined,
    tokens: undefined,
    tools: new Map(),
    toolOutputChars: 0,
    turns: 0,
    userMessages: 0,
  };
}

function finishSession(state: ParseState, truncated: boolean): AgentSessionMetrics | undefined {
  if (state.recognized === 0) {
    return undefined;
  }
  return {
    compactions: state.compactions,
    cwd: state.cwd,
    endedAt: state.endedAt,
    git: state.git,
    initialPromptChars: state.initialPromptChars,
    initialPromptLines: state.initialPromptLines,
    largestToolOutputChars: state.largestToolOutputChars,
    outcomes: state.outcomes,
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
    truncated,
    turns: state.turns,
    userMessages: state.userMessages,
    wallClockMs:
      state.firstMs === undefined || state.lastMs === undefined ? 0 : state.lastMs - state.firstMs,
  };
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
  }
}

function readRecord(state: ParseState, record: Record<string, unknown>, line: number): void {
  const at = trackRecordTime(state, record);
  const type = asString(record["type"]);
  if (type === "compacted") {
    state.recognized += 1;
    state.compactions += 1;
    return;
  }
  const payload = asRecord(record["payload"]);
  if (payload === undefined) {
    return;
  }
  if (type === "session_meta") {
    readSessionMeta(state, payload, line);
  } else if (type === "response_item") {
    readResponseItem(state, payload, at, line);
  } else if (type === "event_msg") {
    readEvent(state, payload, line);
  }
}

/** Folds the record's timestamp into the session's span and returns it as epoch milliseconds. */
function trackRecordTime(state: ParseState, record: Record<string, unknown>): number | undefined {
  const timestamp = asString(record["timestamp"]);
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
    repositoryUrl: asString(git?.["repository_url"]) ?? fallback.repositoryUrl,
  };
}

function readResponseItem(
  state: ParseState,
  payload: Record<string, unknown>,
  at: number | undefined,
  line: number,
): void {
  const kind = asString(payload["type"]);
  recordPromptMessage(state, payload, kind, line);
  if (kind === "function_call" || kind === "custom_tool_call") {
    state.recognized += 1;
    readToolCall(state, payload, at, line);
  } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
    state.recognized += 1;
    readToolResult(state, payload, at, line);
  }
}

function recordPromptMessage(
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

function recordInitialPrompt(state: ParseState, text: string | undefined, line: number): void {
  if (text === undefined || text === "") {
    return;
  }
  state.initialPromptChars += text.length;
  state.initialPromptLines.push(line);
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
