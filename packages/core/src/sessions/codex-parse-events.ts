import { callCommandIdentity, type CommandIdentity } from "./command-identity.js";
import {
  commandUsage,
  releaseCommandUsage,
  usage,
  type ParseState,
  type PendingCall,
} from "./codex-parse-state.js";
import {
  addTurnToolCall,
  addTurnToolTime,
  readPatchApply,
  readTaskComplete,
  readTaskStarted,
  readTurnAborted,
  readUserMessage,
} from "./codex-parse-turns.js";
import { readTokenUsageEvent } from "./codex-parse-usage.js";
import {
  boundedAdd,
  MAX_DURATION_MS,
  MAX_MCP_SECONDS,
  MAX_NANOSECONDS,
  readBoundedInteger,
} from "./session-numbers.js";
import { asRecord, asString, parseTranscriptRecord } from "./transcript-json.js";

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
    readTokenUsageEvent(state, payload);
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
  const durationMs = mcpDurationMs(state, payload);
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
  used.calls = boundedAdd(used.calls, 1);
  used.durationMs = boundedAdd(used.durationMs, durationMs);
  const bucket = commandUsage(state.commands, mcpIdentity(label));
  bucket.calls = boundedAdd(bucket.calls, 1);
  bucket.durationMs = boundedAdd(bucket.durationMs, durationMs);
  addTurnToolTime(state, turnIndex, durationMs);
  if (unpaired) {
    // A paired `function_call` already counted this call when it started.
    addTurnToolCall(state, turnIndex);
  }
}

function recordMcpFailure(state: ParseState, label: string, callLine: number, line: number): void {
  const tool = usage(state.tools, label);
  tool.failures = boundedAdd(tool.failures, 1);
  const command = commandUsage(state.commands, mcpIdentity(label));
  command.failures = boundedAdd(command.failures, 1);
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

function mcpDurationMs(state: ParseState, payload: Record<string, unknown>): number {
  const duration = asRecord(payload["duration"]);
  if (duration === undefined) {
    return 0;
  }
  const secs = readBoundedInteger(state, duration["secs"], MAX_MCP_SECONDS) ?? 0;
  const nanos = readBoundedInteger(state, duration["nanos"], MAX_NANOSECONDS) ?? 0;
  const durationMs = secs * 1000 + Math.round(nanos / 1_000_000);
  if (durationMs > MAX_DURATION_MS) {
    state.invalidValues += 1;
    return 0;
  }
  return durationMs;
}

function recordMcpOutputSize(
  state: ParseState,
  result: Record<string, unknown> | undefined,
): number {
  const resultChars = result === undefined ? 0 : JSON.stringify(result).length;
  state.toolOutputChars = boundedAdd(state.toolOutputChars, resultChars);
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
