import { usage, type ParseState } from "./codex-parse-state.js";
import type { SessionQuota, SessionTokenUsage } from "./session-metrics.js";
import { asNumber, asRecord, asString, parseTranscriptRecord } from "./transcript-json.js";

/**
 * Readers for Codex `event_msg` records: turn boundaries, user messages, token totals, and MCP
 * tool calls. Split from `codex-parse.ts` only to keep each file within the size cap; the state
 * they fold into is the same parse accumulator.
 */

export function readEvent(state: ParseState, payload: Record<string, unknown>, line: number): void {
  const kind = asString(payload["type"]);
  if (kind === "task_started") {
    state.recognized += 1;
    state.turns += 1;
    return;
  }
  if (kind === "user_message") {
    state.recognized += 1;
    state.userMessages += 1;
    return;
  }
  if (kind === "token_count") {
    state.recognized += 1;
    state.tokens = tokenUsage(payload) ?? state.tokens;
    state.quota = quotaState(payload) ?? state.quota;
    return;
  }
  if (kind === "mcp_tool_call_end") {
    state.recognized += 1;
    readMcpCall(state, payload, line);
  }
}

function readMcpCall(state: ParseState, payload: Record<string, unknown>, line: number): void {
  const label = mcpToolLabel(payload["invocation"]);
  const callLine = takeMcpCallLine(state, payload, line);
  const used = usage(state.tools, label);
  used.calls += 1;
  used.durationMs += mcpDurationMs(payload);
  const result = asRecord(payload["result"]);
  recordMcpOutputSize(state, result);
  if (result !== undefined && "Err" in result) {
    used.failures += 1;
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
}

function takeMcpCallLine(
  state: ParseState,
  payload: Record<string, unknown>,
  fallback: number,
): number {
  const callId = asString(payload["call_id"]);
  const pending = callId === undefined ? undefined : state.pending.get(callId);
  if (callId === undefined || pending === undefined) {
    return fallback;
  }
  removeProvisionalCall(state, pending.tool);
  state.pending.delete(callId);
  return pending.callLine;
}

function removeProvisionalCall(state: ParseState, tool: string): void {
  const provisional = usage(state.tools, tool);
  provisional.calls = Math.max(provisional.calls - 1, 0);
  if (provisional.calls === 0 && provisional.durationMs === 0 && provisional.failures === 0) {
    state.tools.delete(tool);
  }
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

function recordMcpOutputSize(state: ParseState, result: Record<string, unknown> | undefined): void {
  const resultChars = result === undefined ? 0 : JSON.stringify(result).length;
  state.toolOutputChars += resultChars;
  state.largestToolOutputChars = Math.max(state.largestToolOutputChars, resultChars);
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
