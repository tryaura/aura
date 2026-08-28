import type { SessionParseResult } from "./analyze-finish.js";
import { createClaudeParseState, type ClaudeParseState } from "./claude-parse-state.js";
import { readClaudeToolResult, readClaudeToolUse } from "./claude-parse-tools.js";
import {
  closeClaudeTurn,
  isInterruptMarker,
  openClaudeTurn,
  readClaudeInterrupt,
} from "./claude-parse-turns.js";
import { readClaudeUsage } from "./claude-parse-usage.js";
import { finishSessionMetrics } from "./session-finish.js";
import { readTranscriptLines, readTranscriptLineStream } from "./session-parse-lines.js";
import { trackRecordTime } from "./session-parse-state.js";
import { contentText } from "./session-prompt.js";
import type { SessionDetailLevel } from "./session-detail-metrics.js";
import type { AgentSessionMetrics } from "./session-metrics.js";
import { boundedAdd } from "./session-numbers.js";
import { asRecord, asString } from "./transcript-json.js";
import { collectPullRequests } from "./work-items.js";

/**
 * Extracts {@link AgentSessionMetrics} from one Claude Code transcript.
 *
 * A transcript is a line-delimited JSON log of conversation records (`user`, `assistant`,
 * `system`, `attachment`) that carry a common envelope, interleaved with envelope-less sidecar
 * records (`ai-title`, `mode`, `pr-link`, …) that may appear anywhere, including line one. The
 * format is Claude Code's private state, so every read is defensive: unexpected shapes are
 * skipped, never fatal. Subagent transcripts live in per-session subdirectories and sidechain
 * records are skipped, so a session's metrics cover its main thread only.
 */

export function parseClaudeSession(
  content: string,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
): AgentSessionMetrics | undefined {
  const result = parseClaudeSessionResult(content, truncated, detail);
  return result.kind === "session" ? result.session : undefined;
}

export function parseClaudeSessionResult(
  content: string,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
  readError = false,
): SessionParseResult {
  const state = createClaudeParseState(detail);
  readTranscriptLines(state, content, truncated, readRecord);
  return finishSession(state, truncated, readError);
}

export async function parseClaudeSessionLinesResult(
  lines: AsyncIterable<string>,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
  completed?: (() => boolean) | undefined,
): Promise<SessionParseResult> {
  const state = createClaudeParseState(detail);
  await readTranscriptLineStream(state, lines, readRecord);
  return finishSession(state, truncated, completed?.() === false);
}

function finishSession(
  state: ClaudeParseState,
  truncated: boolean,
  readError = false,
): SessionParseResult {
  if (state.recognized === 0) {
    return { kind: "unrecognized" };
  }
  // A final turn the log recorded as finished counts; only then can the shared copy run.
  closeClaudeTurn(state);
  state.editFiles = state.editedFiles.size;
  return {
    kind: "session",
    session: finishSessionMetrics(state, "claude-code", truncated, readError),
  };
}

/** Conversation record types; sidecars fall outside and carry no envelope at all. */
const CONVERSATION_TYPES = new Set(["assistant", "attachment", "system", "user"]);

function readRecord(state: ClaudeParseState, record: Record<string, unknown>, line: number): void {
  if (record["isSidechain"] === true) {
    return;
  }
  const type = asString(record["type"]);
  if (type === "pr-link") {
    readPrLink(state, record);
    return;
  }
  if (type !== undefined && CONVERSATION_TYPES.has(type)) {
    readConversationRecord(state, record, type, line);
  }
}

function readConversationRecord(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  type: string,
  line: number,
): void {
  const timestamp = asString(record["timestamp"]);
  const at = trackRecordTime(state, timestamp);
  if (type === "system" || type === "attachment") {
    // Their timestamps extend the wall clock; only a compaction boundary carries a metric.
    readSystemRecord(state, record, type);
    return;
  }
  if (timestamp === undefined || !isConversationEnvelope(record)) {
    return;
  }
  state.recognized += 1;
  readEnvelope(state, record);
  if (type === "assistant") {
    readAssistantRecord(state, record, timestamp, at, line);
  } else {
    readUserRecord(state, record, timestamp, at, line);
  }
}

function readPrLink(state: ClaudeParseState, record: Record<string, unknown>): void {
  const url = asString(record["prUrl"]);
  if (url !== undefined) {
    collectPullRequests(state.pullRequests, url);
  }
}

/** The compaction boundary of older transcript versions; newer ones record none at all. */
function readSystemRecord(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  type: string,
): void {
  if (type === "system" && asString(record["subtype"]) === "compact_boundary") {
    state.compactions = boundedAdd(state.compactions, 1);
  }
}

function isConversationEnvelope(record: Record<string, unknown>): boolean {
  return asString(record["uuid"]) !== undefined && asString(record["sessionId"]) !== undefined;
}

/** Session identity rides on every conversation record; the first sighting of each wins. */
function readEnvelope(state: ClaudeParseState, record: Record<string, unknown>): void {
  state.sessionId ??= asString(record["sessionId"]);
  state.cwd ??= asString(record["cwd"]);
  if (state.git.branch === undefined) {
    const branch = asString(record["gitBranch"]);
    if (branch !== undefined && branch !== "") {
      state.git = { ...state.git, branch };
    }
  }
}

function readAssistantRecord(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  const message = asRecord(record["message"]);
  if (message === undefined) {
    return;
  }
  readClaudeUsage(state, record, message);
  const content = message["content"];
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    const toolUse = asRecord(block);
    if (toolUse !== undefined && toolUse["type"] === "tool_use") {
      readClaudeToolUse(state, toolUse, timestamp, at, line);
    }
  }
}

/** A user record is either a batch of tool results or a prompt; never both here. */
function readUserRecord(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  const content = asRecord(record["message"])?.["content"];
  const results = toolResultBlocks(content);
  if (results.length > 0) {
    for (const block of results) {
      readClaudeToolResult(state, record, block, at, line);
    }
    return;
  }
  if (record["isMeta"] === true) {
    return;
  }
  if (record["isCompactSummary"] === true) {
    state.compactions = boundedAdd(state.compactions, 1);
    return;
  }
  const text = contentText(content);
  if (isInterruptMarker(text)) {
    readClaudeInterrupt(state, timestamp, at, line);
    return;
  }
  openClaudeTurn(state, asString(record["promptSource"]) ?? "typed", text, timestamp, at, line);
}

function toolResultBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    const result = asRecord(block);
    return result !== undefined && result["type"] === "tool_result" ? [result] : [];
  });
}
