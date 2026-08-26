import { callCommandIdentity, type CommandIdentity } from "./command-identity.js";
import {
  commandUsage,
  releaseCommandUsage,
  usage,
  type ParseState,
  type PendingCall,
} from "./codex-parse-state.js";
import {
  addTurnTokens,
  addTurnToolCall,
  addTurnToolTime,
  readPatchApply,
  readTaskComplete,
  readTaskStarted,
  readTurnAborted,
  readUserMessage,
} from "./codex-parse-turns.js";
import type { SessionQuota, SessionTokenUsage } from "./session-metrics.js";
import { asNumber, asRecord, asString, parseTranscriptRecord } from "./transcript-json.js";

/**
 * Readers for Codex `event_msg` records: turn boundaries, user messages, token totals, and MCP
 * tool calls. Split from `codex-parse.ts` only to keep each file within the size cap; the state
 * they fold into is the same parse accumulator.
 */

export function readEvent(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  const kind = asString(payload["type"]);
  if (kind === "task_started") {
    state.recognized += 1;
    readTaskStarted(state, payload, timestamp, at);
    return;
  }
  if (kind === "task_complete") {
    state.recognized += 1;
    readTaskComplete(state, payload, timestamp, at);
    return;
  }
  if (kind === "turn_aborted") {
    state.recognized += 1;
    readTurnAborted(state, payload, timestamp, at, line);
    return;
  }
  if (kind === "user_message") {
    state.recognized += 1;
    readUserMessage(state, payload, line);
    return;
  }
  if (kind === "token_count") {
    state.recognized += 1;
    state.tokens = tokenUsage(payload) ?? state.tokens;
    state.quota = quotaState(payload) ?? state.quota;
    readContextUsage(state, payload);
    return;
  }
  if (kind === "patch_apply_end") {
    state.recognized += 1;
    readPatchApply(state, payload);
    return;
  }
  if (isApprovalRequest(kind)) {
    state.recognized += 1;
    state.interventions.push({ kind: "approval", line, turnIndex: state.openTurn?.index });
    return;
  }
  if (kind === "mcp_tool_call_end") {
    state.recognized += 1;
    readMcpCall(state, payload, line);
  }
}

/** The agent paused for a person to allow a command or a patch. */
function isApprovalRequest(kind: string | undefined): boolean {
  return kind === "exec_approval_request" || kind === "apply_patch_approval_request";
}

function readMcpCall(state: ParseState, payload: Record<string, unknown>, line: number): void {
  const label = mcpToolLabel(payload["invocation"]);
  const pending = takeMcpPending(state, payload);
  const durationMs = mcpDurationMs(payload);
  const turnIndex = pending?.turnIndex ?? state.openTurn?.index;
  recordMcpUsage(state, label, durationMs, turnIndex, pending === undefined);
  const result = asRecord(payload["result"]);
  recordMcpResult(state, {
    callId: asString(payload["call_id"]),
    callLine: pending?.callLine ?? line,
    durationMs,
    failed: result !== undefined && "Err" in result,
    label,
    line,
    resultChars: recordMcpOutputSize(state, result),
    startedAt: pending?.startedAt,
    turnIndex,
  });
}

interface McpResult {
  readonly callId: string | undefined;
  readonly callLine: number;
  readonly durationMs: number;
  readonly failed: boolean;
  readonly label: string;
  readonly line: number;
  readonly resultChars: number;
  readonly startedAt: string | undefined;
  readonly turnIndex: number | undefined;
}

function recordMcpResult(state: ParseState, result: McpResult): void {
  if (result.failed) {
    recordMcpFailure(state, result.label, result.callLine, result.line);
  }
  state.calls?.push({
    callId: result.callId,
    callLine: result.callLine,
    command: undefined,
    durationMs: result.durationMs,
    exitCode: undefined,
    outputChars: result.resultChars,
    startedAt: result.startedAt,
    status: result.failed ? "failure" : "ok",
    subcommand: undefined,
    tool: result.label,
    turnIndex: result.turnIndex,
  });
}

function recordMcpUsage(
  state: ParseState,
  label: string,
  durationMs: number,
  turnIndex: number | undefined,
  unpaired: boolean,
): void {
  const used = usage(state.tools, label);
  used.calls += 1;
  used.durationMs += durationMs;
  const bucket = commandUsage(state.commands, mcpIdentity(label));
  bucket.calls += 1;
  bucket.durationMs += durationMs;
  addTurnToolTime(state, turnIndex, durationMs);
  if (unpaired) {
    // A paired `function_call` already counted this call when it started.
    addTurnToolCall(state, turnIndex);
  }
}

function recordMcpFailure(state: ParseState, label: string, callLine: number, line: number): void {
  usage(state.tools, label).failures += 1;
  commandUsage(state.commands, mcpIdentity(label)).failures += 1;
  state.outcomes.push({
    callLine,
    confidence: "high",
    exitCode: undefined,
    kind: "tool_error",
    label,
    reason: "the MCP runtime recorded an error result",
    resultLine: line,
    tool: label,
  });
}

function mcpIdentity(label: string): CommandIdentity {
  return { command: undefined, subcommand: undefined, tool: label };
}

/** Claims the paired `function_call`, backing its provisional counts out of the totals. */
function takeMcpPending(
  state: ParseState,
  payload: Record<string, unknown>,
): PendingCall | undefined {
  const callId = asString(payload["call_id"]);
  const pending = callId === undefined ? undefined : state.pending.get(callId);
  if (callId === undefined || pending === undefined) {
    return undefined;
  }
  state.pending.delete(callId);
  const provisional = usage(state.tools, pending.tool);
  provisional.calls = Math.max(provisional.calls - 1, 0);
  if (provisional.calls === 0 && provisional.durationMs === 0 && provisional.failures === 0) {
    state.tools.delete(pending.tool);
  }
  releaseCommandUsage(state.commands, callCommandIdentity(pending));
  return pending;
}

function mcpDurationMs(payload: Record<string, unknown>): number {
  const duration = asRecord(payload["duration"]);
  if (duration === undefined) {
    return 0;
  }
  const secs = asNumber(duration["secs"]) ?? 0;
  const nanos = asNumber(duration["nanos"]) ?? 0;
  return secs * 1000 + Math.round(nanos / 1_000_000);
}

function recordMcpOutputSize(
  state: ParseState,
  result: Record<string, unknown> | undefined,
): number {
  const resultChars = result === undefined ? 0 : JSON.stringify(result).length;
  state.toolOutputChars += resultChars;
  state.largestToolOutputChars = Math.max(state.largestToolOutputChars, resultChars);
  return resultChars;
}

/** `mcp:<server>.<tool>` from the invocation Codex records as a JSON string. */
function mcpToolLabel(invocation: unknown): string {
  const raw = asString(invocation);
  const parsed = raw === undefined ? asRecord(invocation) : parseTranscriptRecord(raw);
  if (parsed === undefined) {
    return "mcp:unknown";
  }
  const server = asString(parsed["server"]) ?? "unknown";
  const tool = asString(parsed["tool"]) ?? "unknown";
  return `mcp:${server}.${tool}`;
}

/**
 * Folds one usage record's per-request delta into the context-occupancy observations.
 *
 * The cumulative totals cannot answer window questions — they keep growing across compactions —
 * so occupancy comes from `last_token_usage`, the size of the one request just made. Its
 * `input_tokens` already include the cached share.
 */
function readContextUsage(state: ParseState, payload: Record<string, unknown>): void {
  const info = asRecord(payload["info"]);
  if (info === undefined) {
    return;
  }
  state.contextWindow = asNumber(info["model_context_window"]) ?? state.contextWindow;
  const last = asRecord(info["last_token_usage"]);
  if (last === undefined) {
    return;
  }
  const inputTokens = asNumber(last["input_tokens"]) ?? 0;
  const outputTokens = asNumber(last["output_tokens"]) ?? 0;
  if (state.initialContextTokens === undefined) {
    state.initialContextTokens = inputTokens;
  }
  const requestTokens = asNumber(last["total_tokens"]) ?? inputTokens + outputTokens;
  state.peakRequestTokens = Math.max(state.peakRequestTokens, requestTokens);
  addTurnTokens(state.openTurn, {
    cachedInputTokens: asNumber(last["cached_input_tokens"]) ?? 0,
    inputTokens,
    outputTokens,
  });
}

/** The subscription-quota snapshot a usage record carries, when it carries one. */
function quotaState(payload: Record<string, unknown>): SessionQuota | undefined {
  const limits = asRecord(payload["rate_limits"]);
  const primary = asRecord(limits?.["primary"]);
  const usedPercent = asNumber(primary?.["used_percent"]);
  if (limits === undefined || usedPercent === undefined) {
    return undefined;
  }
  return {
    planType: asString(limits["plan_type"]),
    usedPercent,
    windowMinutes: asNumber(primary?.["window_minutes"]),
  };
}

function tokenUsage(payload: Record<string, unknown>): SessionTokenUsage | undefined {
  const totals = asRecord(asRecord(payload["info"])?.["total_token_usage"]);
  if (totals === undefined) {
    return undefined;
  }
  return {
    cachedInputTokens: asNumber(totals["cached_input_tokens"]) ?? 0,
    inputTokens: asNumber(totals["input_tokens"]) ?? 0,
    outputTokens: asNumber(totals["output_tokens"]) ?? 0,
  };
}
