import type { SessionParseResult } from "./analyze-finish.js";
import { readEvent } from "./codex-parse-events.js";
import { recordPromptMessage } from "./codex-parse-prompt.js";
import { recordInitialPrompt } from "./session-prompt.js";
import { readToolCall, readToolResult } from "./codex-parse-tools.js";
import { readTurnContext } from "./codex-parse-turns.js";
import { finishSessionMetrics } from "./session-finish.js";
import { createParseState } from "./session-parse-initialize.js";
import { readTranscriptLines, readTranscriptLineStream } from "./session-parse-lines.js";
import { trackRecordTime, type ParseState } from "./session-parse-state.js";
import type { SessionDetailLevel } from "./session-detail-metrics.js";
import type { AgentSessionMetrics } from "./session-metrics.js";
import { boundedAdd } from "./session-numbers.js";
import { sanitizeRepositoryUrl } from "./project-resolve.js";
import { asRecord, asString } from "./transcript-json.js";

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
  const result = parseCodexSessionResult(content, truncated, detail);
  return result.kind === "session" ? result.session : undefined;
}

export function parseCodexSessionResult(
  content: string,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
  readError = false,
): SessionParseResult {
  const state = createParseState(detail);
  readTranscriptLines(state, content, truncated, readRecord);
  return finishSession(state, truncated, readError);
}

export async function parseCodexSessionLinesResult(
  lines: AsyncIterable<string>,
  truncated: boolean,
  detail: SessionDetailLevel = "summary",
  completed?: (() => boolean) | undefined,
): Promise<SessionParseResult> {
  const state = createParseState(detail);
  await readTranscriptLineStream(state, lines, readRecord);
  return finishSession(state, truncated, completed?.() === false);
}

function finishSession(
  state: ParseState,
  truncated: boolean,
  readError = false,
): SessionParseResult {
  if (state.internalApprovalReview) {
    return { kind: "excluded" };
  }
  if (state.recognized === 0) {
    return { kind: "unrecognized" };
  }
  return { kind: "session", session: finishSessionMetrics(state, "codex", truncated, readError) };
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
