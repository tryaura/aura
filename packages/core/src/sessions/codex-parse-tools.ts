import { classifyShellOutcome, shellIdentity } from "./outcome-classify.js";
import { callCommandIdentity, shellSubcommand } from "./command-identity.js";
import { commandUsage, usage, type ParseState, type PendingCall } from "./codex-parse-state.js";
import { addTurnToolCall, addTurnToolTime } from "./codex-parse-turns.js";
import { runningShellSessionId, shellContinuation } from "./shell-session.js";
import type { SessionToolCall } from "./session-detail-metrics.js";
import { asString } from "./transcript-json.js";
import { isValidationIdentity } from "./validation-classify.js";
import { collectPullRequests, collectWorkItems } from "./work-items.js";
import { boundedAdd, MAX_DURATION_MS, readBoundedInteger } from "./session-numbers.js";

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
  const durationMs = recordDuration(state, call, at);
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
  recordValidationAttempt(state, call, durationMs, exitCode);
  recordCallRow(state, call, durationMs, output.length, exitCode);
  recordNonzeroOutcome(state, call, output, line, exitCode);
}

/** Tracks validation spend and the first green run. The identity gate keeps this conservative. */
function recordValidationAttempt(
  state: ParseState,
  call: PendingCall,
  durationMs: number | undefined,
  exitCode: number | undefined,
): void {
  const identity = callCommandIdentity(call);
  if (!isValidationIdentity(identity.command, identity.subcommand)) {
    return;
  }
  state.validationAttempts = boundedAdd(state.validationAttempts, 1);
  state.validationTimeMs = boundedAdd(state.validationTimeMs, durationMs ?? 0);
  if (exitCode !== undefined) {
    state.validationFailures = boundedAdd(state.validationFailures, 1);
    return;
  }
  if (state.greenIteration === undefined) {
    state.greenIteration = state.validationAttempts;
    state.tokensAtFirstGreen = state.tokens;
  }
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

function recordDuration(
  state: ParseState,
  call: PendingCall,
  at: number | undefined,
): number | undefined {
  if (call.at === undefined || at === undefined || at < call.at) {
    return undefined;
  }
  const elapsed = readBoundedInteger(state, at - call.at, MAX_DURATION_MS);
  if (elapsed === undefined) {
    return undefined;
  }
  const tool = usage(state.tools, call.tool);
  tool.durationMs = boundedAdd(tool.durationMs, elapsed);
  const command = commandUsage(state.commands, callCommandIdentity(call));
  command.durationMs = boundedAdd(command.durationMs, elapsed);
  addTurnToolTime(state, call.turnIndex, elapsed);
  return elapsed;
}

function recordOutputSize(state: ParseState, payload: Record<string, unknown>): string {
  const output = asString(payload["output"]) ?? "";
  state.toolOutputChars = boundedAdd(state.toolOutputChars, output.length);
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

/** Flushes calls whose results never arrived, then returns every row in transcript order. */
export function finishCalls(state: ParseState): readonly SessionToolCall[] | undefined {
  if (state.calls === undefined) {
    return undefined;
  }
  for (const call of state.pending.values()) {
    const identity = callCommandIdentity(call);
    state.calls.push({
      callId: call.callId,
      callLine: call.callLine,
      command: identity.command,
      durationMs: undefined,
      exitCode: undefined,
      outputChars: 0,
      startedAt: call.startedAt,
      status: "unpaired",
      subcommand: identity.subcommand,
      tool: call.tool,
      turnIndex: call.turnIndex,
    });
  }
  return [...state.calls].sort((a, b) => a.callLine - b.callLine);
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
  const tool = usage(state.tools, call.tool);
  tool.failures = boundedAdd(tool.failures, 1);
  const command = commandUsage(state.commands, callCommandIdentity(call));
  command.failures = boundedAdd(command.failures, 1);
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
