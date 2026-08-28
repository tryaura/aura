import { callCommandIdentity } from "./command-identity.js";
import type { OutcomeClassification } from "./outcome-classify.js";
import { commandUsage, usage, type ParseState, type PendingCall } from "./session-parse-state.js";
import type { SessionToolCall } from "./session-detail-metrics.js";
import { boundedAdd, MAX_DURATION_MS, readBoundedInteger } from "./session-numbers.js";
import { addTurnToolTime } from "./session-turn-fold.js";
import { isValidationIdentity } from "./validation-classify.js";

/**
 * Source-agnostic call folding: durations, output sizes, and the final per-call rows. Each source
 * parser pairs its own call and result records; what a paired call contributes is identical.
 */

/** Folds one paired call's elapsed time into its tool, command, and turn accumulators. */
export function recordCallDuration(
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

/** Folds one result's output size into the session's output totals. */
export function recordCallOutput(state: ParseState, output: string): void {
  state.toolOutputChars = boundedAdd(state.toolOutputChars, output.length);
  state.largestToolOutputChars = Math.max(state.largestToolOutputChars, output.length);
}

/** Tracks validation spend and the first green run. The identity gate keeps this conservative. */
export function recordValidationResult(
  state: ParseState,
  call: PendingCall,
  durationMs: number | undefined,
  failed: boolean,
): void {
  const identity = callCommandIdentity(call);
  if (!isValidationIdentity(identity.command, identity.subcommand)) {
    return;
  }
  state.validationAttempts = boundedAdd(state.validationAttempts, 1);
  state.validationTimeMs = boundedAdd(state.validationTimeMs, durationMs ?? 0);
  if (failed) {
    state.validationFailures = boundedAdd(state.validationFailures, 1);
    return;
  }
  if (state.greenIteration === undefined) {
    state.greenIteration = state.validationAttempts;
    state.tokensAtFirstGreen = state.tokens;
  }
}

/** Folds one failed call into its tool and command buckets and records the classified outcome. */
export function recordFailureOutcome(
  state: ParseState,
  call: PendingCall,
  classification: OutcomeClassification,
  exitCode: number | undefined,
  line: number,
): void {
  const tool = usage(state.tools, call.tool);
  tool.failures = boundedAdd(tool.failures, 1);
  const command = commandUsage(state.commands, callCommandIdentity(call));
  command.failures = boundedAdd(command.failures, 1);
  state.outcomes.push({
    ...(call.batchComponents === undefined || call.batchComponents.length === 0
      ? {}
      : { batchComponents: call.batchComponents }),
    callLine: call.callLine,
    ...classification,
    exitCode,
    label: call.label,
    resultLine: line,
    tool: call.tool,
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
