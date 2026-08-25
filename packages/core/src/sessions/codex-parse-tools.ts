import { classifyShellOutcome, shellIdentity } from "./outcome-classify.js";
import { usage, type ParseState, type PendingCall } from "./codex-parse-state.js";
import { runningShellSessionId, shellContinuation } from "./shell-session.js";
import { asString } from "./transcript-json.js";

const EXIT_CODE = /exited with code (\d+)/u;

export function readToolCall(
  state: ParseState,
  payload: Record<string, unknown>,
  at: number | undefined,
  line: number,
): void {
  state.promptOpen = false;
  const name = asString(payload["name"]) ?? "unknown";
  const provisionalTool = name === "exec_command" ? "shell" : name;
  const pending = pendingCall(state, payload, at, line, name, provisionalTool);
  const tool = pending?.tool ?? provisionalTool;
  usage(state.tools, tool).calls += 1;
  const callId = asString(payload["call_id"]);
  if (callId !== undefined && pending !== undefined) {
    state.pending.set(callId, pending);
  }
}

function pendingCall(
  state: ParseState,
  payload: Record<string, unknown>,
  at: number | undefined,
  line: number,
  name: string,
  tool: string,
): PendingCall | undefined {
  if (name === "write_stdin") {
    return shellContinuation(state, payload["arguments"], at);
  }
  const identity = name === "exec_command" ? shellIdentity(payload["arguments"]) : undefined;
  return {
    at,
    callLine: line,
    command: identity?.command,
    label: identity?.label ?? tool,
    shellSessionId: undefined,
    tool,
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
  recordDuration(state, call, at);
  const output = recordOutputSize(state, payload);
  if (keepRunningShellSession(state, call, output)) {
    return;
  }
  completeShellSession(state, call);
  recordNonzeroOutcome(state, call, output, line);
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

function recordDuration(state: ParseState, call: PendingCall, at: number | undefined): void {
  if (call.at !== undefined && at !== undefined && at >= call.at) {
    usage(state.tools, call.tool).durationMs += at - call.at;
  }
}

function recordOutputSize(state: ParseState, payload: Record<string, unknown>): string {
  const output = asString(payload["output"]) ?? "";
  state.toolOutputChars += output.length;
  state.largestToolOutputChars = Math.max(state.largestToolOutputChars, output.length);
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

function recordNonzeroOutcome(
  state: ParseState,
  call: PendingCall,
  output: string,
  line: number,
): void {
  const exitCode = failureExitCode(output);
  if (exitCode === undefined) {
    return;
  }
  usage(state.tools, call.tool).failures += 1;
  const classification = classifyShellOutcome(
    { command: call.command, label: call.label },
    exitCode,
    output,
  );
  state.outcomes.push({
    callLine: call.callLine,
    ...classification,
    exitCode,
    label: call.label,
    resultLine: line,
    tool: call.tool,
  });
}

function failureExitCode(output: string): number | undefined {
  const code = EXIT_CODE.exec(output)?.[1];
  return code === undefined || code === "0" ? undefined : Number(code);
}
