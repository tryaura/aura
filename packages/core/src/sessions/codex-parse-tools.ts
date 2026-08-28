import { classifyShellOutcome, shellIdentity } from "./outcome-classify.js";
import { callCommandIdentity, shellSubcommand } from "./command-identity.js";
import { commandUsage, usage, type ParseState, type PendingCall } from "./session-parse-state.js";
import {
  recordCallDuration,
  recordCallOutput,
  recordFailureOutcome,
  recordValidationResult,
} from "./session-call-fold.js";
import { addTurnToolCall } from "./session-turn-fold.js";
import { runningShellSessionId, shellContinuation } from "./shell-session.js";
import { asString } from "./transcript-json.js";
import { collectPullRequests, collectWorkItems } from "./work-items.js";
import { boundedAdd } from "./session-numbers.js";

const EXIT_CODE = /exited with code (\d+)/u;

export function readToolCall(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
): void {
  state.promptOpen = false;
  const name = asString(payload["name"]) ?? "unknown";
  const provisionalTool = name === "exec_command" ? "shell" : name;
  const pending = pendingCall(state, payload, timestamp, at, line, name, provisionalTool);
  const tool = pending?.tool ?? provisionalTool;
  const toolUsage = usage(state.tools, tool);
  toolUsage.calls = boundedAdd(toolUsage.calls, 1);
  const identity =
    pending === undefined
      ? { command: undefined, subcommand: undefined, tool }
      : callCommandIdentity(pending);
  const command = commandUsage(state.commands, identity);
  command.calls = boundedAdd(command.calls, 1);
  addTurnToolCall(state, pending?.turnIndex ?? state.openTurn?.index);
  collectCommandWorkItems(state, pending);
  const callId = asString(payload["call_id"]);
  if (callId !== undefined && pending !== undefined) {
    state.pending.set(callId, { ...pending, callId });
  }
}

/** Branch names and PR titles ride in git/gh command lines; only their issue keys are kept. */
function collectCommandWorkItems(state: ParseState, call: PendingCall | undefined): void {
  if (call === undefined || call.command === undefined) {
    return;
  }
  if (call.label === "git" || call.label === "gh") {
    collectWorkItems(state.workItems, call.command);
  }
}

function pendingCall(
  state: ParseState,
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  at: number | undefined,
  line: number,
  name: string,
  tool: string,
): PendingCall | undefined {
  if (name === "write_stdin") {
    return shellContinuation(state, payload["arguments"], timestamp, at);
  }
  const identity = name === "exec_command" ? shellIdentity(payload["arguments"]) : undefined;
  const label = identity?.label ?? tool;
  return {
    at,
    batchComponents: identity?.batchComponents,
    callId: undefined,
    callLine: line,
    command: identity?.command,
    label,
    shellSessionId: undefined,
    startedAt: timestamp,
    subcommand: identity === undefined ? undefined : shellSubcommand(identity.command, label),
    tool,
    turnIndex: state.openTurn?.index,
  };
}

export function readToolResult(
  state: ParseState,
  payload: Record<string, unknown>,
  at: number | undefined,
  line: number,
): void {
  const call = takePendingCall(state, payload);
  if (call === undefined) {
    return;
  }
  const durationMs = recordCallDuration(state, call, at);
  const output = recordOutputSize(state, payload);
  if (keepRunningShellSession(state, call, output)) {
    recordCallRow(state, call, durationMs, output.length, undefined);
    return;
  }
  completeShellSession(state, call);
  const exitCode = failureExitCode(output);
  if (call.label === "gh" && exitCode === undefined) {
    collectPullRequests(state.pullRequests, output);
  }
  recordValidationResult(state, call, durationMs, exitCode !== undefined);
  recordCallRow(state, call, durationMs, output.length, exitCode);
  recordNonzeroOutcome(state, call, output, line, exitCode);
}

function takePendingCall(
  state: ParseState,
  payload: Record<string, unknown>,
): PendingCall | undefined {
  const callId = asString(payload["call_id"]);
  if (callId === undefined) {
    return undefined;
  }
  const call = state.pending.get(callId);
  state.pending.delete(callId);
  return call;
}

function recordOutputSize(state: ParseState, payload: Record<string, unknown>): string {
  const output = asString(payload["output"]) ?? "";
  recordCallOutput(state, output);
  return output;
}

function keepRunningShellSession(state: ParseState, call: PendingCall, output: string): boolean {
  const sessionId = runningShellSessionId(output);
  if (sessionId === undefined) {
    return false;
  }
  state.shellSessions.set(sessionId, { ...call, shellSessionId: sessionId });
  return true;
}

function completeShellSession(state: ParseState, call: PendingCall): void {
  if (call.shellSessionId !== undefined) {
    state.shellSessions.delete(call.shellSessionId);
  }
}

function recordCallRow(
  state: ParseState,
  call: PendingCall,
  durationMs: number | undefined,
  outputChars: number,
  exitCode: number | undefined,
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
    exitCode,
    outputChars,
    startedAt: call.startedAt,
    status: exitCode === undefined ? "ok" : "failure",
    subcommand: identity.subcommand,
    tool: call.tool,
    turnIndex: call.turnIndex,
  });
}

function recordNonzeroOutcome(
  state: ParseState,
  call: PendingCall,
  output: string,
  line: number,
  exitCode: number | undefined,
): void {
  if (exitCode === undefined) {
    return;
  }
  const classification = classifyShellOutcome(
    { command: call.command, label: call.label },
    exitCode,
    output,
  );
  recordFailureOutcome(state, call, classification, exitCode, line);
}

function failureExitCode(output: string): number | undefined {
  const code = EXIT_CODE.exec(output)?.[1];
  return code === undefined || code === "0" ? undefined : Number(code);
}
