import type { ClaudeParseState } from "./claude-parse-state.js";
import { callCommandIdentity, shellSubcommand } from "./command-identity.js";
import {
  classifyShellOutcome,
  shellIdentityFromCommand,
  type OutcomeClassification,
} from "./outcome-classify.js";
import {
  recordCallDuration,
  recordCallOutput,
  recordFailureOutcome,
  recordValidationResult,
} from "./session-call-fold.js";
import { commandUsage, usage, type PendingCall } from "./session-parse-state.js";
import { boundedAdd } from "./session-numbers.js";
import { addTurnToolCall } from "./session-turn-fold.js";
import { asRecord, asString } from "./transcript-json.js";
import { collectPullRequests, collectWorkItems } from "./work-items.js";

/**
 * Tool-call pairing for a Claude Code transcript: an assistant `tool_use` block opens a pending
 * call, a later user-record `tool_result` block closes it by id. Failure is structural
 * (`is_error`), never an exit code echoed into output.
 */

export function readClaudeToolUse(
  state: ClaudeParseState,
  block: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  const rawName = asString(block["name"]) ?? "unknown";
  // Older Claude Code versions call the subagent tool `Task`; newer ones `Agent`.
  const name = rawName === "Task" ? "Agent" : rawName;
  const input = asRecord(block["input"]);
  const identity =
    name === "Bash" ? shellIdentityFromCommand(asString(input?.["command"])) : undefined;
  const tool = name === "Bash" ? "shell" : name;
  const label = identity?.label ?? tool;
  const call: PendingCall = {
    at,
    batchComponents: identity?.batchComponents,
    callId: asString(block["id"]),
    callLine: line,
    command: identity?.command,
    label,
    shellSessionId: undefined,
    startedAt: timestamp,
    subcommand: identity === undefined ? undefined : shellSubcommand(identity.command, label),
    tool,
    turnIndex: state.openTurn?.index,
  };
  const toolUsage = usage(state.tools, tool);
  toolUsage.calls = boundedAdd(toolUsage.calls, 1);
  const command = commandUsage(state.commands, callCommandIdentity(call));
  command.calls = boundedAdd(command.calls, 1);
  addTurnToolCall(state, call.turnIndex);
  // Branch names and PR titles ride in git/gh command lines; only their issue keys are kept.
  if (call.command !== undefined && (label === "git" || label === "gh")) {
    collectWorkItems(state.workItems, call.command);
  }
  if (call.callId !== undefined) {
    state.pending.set(call.callId, call);
    recordPendingEdit(state, name, call.callId, input);
  }
}

function recordPendingEdit(
  state: ClaudeParseState,
  name: string,
  callId: string,
  input: Record<string, unknown> | undefined,
): void {
  if (name !== "Edit" && name !== "Write") {
    return;
  }
  const filePath = asString(input?.["file_path"]);
  if (filePath !== undefined) {
    state.pendingEditFiles.set(callId, filePath);
  }
}

export function readClaudeToolResult(
  state: ClaudeParseState,
  record: Record<string, unknown>,
  block: Record<string, unknown>,
  at: number | undefined,
  line: number,
): void {
  const callId = asString(block["tool_use_id"]);
  if (callId === undefined) {
    return;
  }
  const call = state.pending.get(callId);
  state.pending.delete(callId);
  if (call === undefined) {
    return;
  }
  const durationMs = recordCallDuration(state, call, at);
  const output = resultText(record, block);
  recordCallOutput(state, output);
  const failed = block["is_error"] === true;
  recordClaudeEdit(state, callId, failed);
  if (call.label === "gh" && !failed) {
    collectPullRequests(state.pullRequests, output);
  }
  recordValidationResult(state, call, durationMs, failed);
  recordClaudeCallRow(state, call, durationMs, output.length, failed);
  if (failed) {
    const classification = classifyClaudeFailure(call, output);
    recordFailureOutcome(state, call, classification, undefined, line);
  }
}

function classifyClaudeFailure(call: PendingCall, output: string): OutcomeClassification {
  if (call.tool.startsWith("mcp__")) {
    return {
      confidence: "high",
      kind: "tool_error",
      reason: "the MCP runtime recorded an error result",
    };
  }
  return classifyShellOutcome({ command: call.command, label: call.label }, undefined, output);
}

/**
 * The result text as the model saw it: the `tool_result` content, falling back to the raw
 * `toolUseResult` sidecar, which is a bare string exactly when the call errored.
 */
function resultText(record: Record<string, unknown>, block: Record<string, unknown>): string {
  const content = block["content"];
  const direct = asString(content);
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        const text = asString(asRecord(part)?.["text"]);
        return text === undefined ? [] : [text];
      })
      .join("\n");
  }
  return asString(record["toolUseResult"]) ?? "";
}

function recordClaudeEdit(state: ClaudeParseState, callId: string, failed: boolean): void {
  const filePath = state.pendingEditFiles.get(callId);
  if (filePath === undefined) {
    return;
  }
  state.pendingEditFiles.delete(callId);
  if (failed) {
    state.editsFailed = boundedAdd(state.editsFailed, 1);
    return;
  }
  state.editsApplied = boundedAdd(state.editsApplied, 1);
  state.editedFiles.add(filePath);
}

function recordClaudeCallRow(
  state: ClaudeParseState,
  call: PendingCall,
  durationMs: number | undefined,
  outputChars: number,
  failed: boolean,
): void {
  if (state.calls === undefined) {
    return;
  }
  const identity = callCommandIdentity(call);
  state.calls.push({
    callId: call.callId,
    callLine: call.callLine,
    command: identity.command,
    durationMs,
    exitCode: undefined,
    outputChars,
    startedAt: call.startedAt,
    status: failed ? "failure" : "ok",
    subcommand: identity.subcommand,
    tool: call.tool,
    turnIndex: call.turnIndex,
  });
}
