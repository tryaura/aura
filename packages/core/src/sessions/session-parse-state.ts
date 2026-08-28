import type { CommandIdentity } from "./command-identity.js";
import { isValidationIdentity } from "./validation-classify.js";
import type {
  SessionCommandUsage,
  SessionContextMetrics,
  SessionEditMetrics,
  SessionIntervention,
  SessionToolCall,
  SessionTurnClose,
  SessionValidationMetrics,
} from "./session-detail-metrics.js";
import type {
  SessionGitContext,
  SessionQuota,
  ShellBatchComponent,
  SessionTokenUsage,
  ToolOutcome,
} from "./session-metrics.js";
import { boundedAdd } from "./session-numbers.js";
import { utcTimestampMs } from "./iso-time.js";

/**
 * The accumulator one transcript parse folds its records into, shared by every source parser.
 *
 * Mutable on purpose: a parser walks a line-delimited log once, and the public result is copied
 * out of this state at the end (`codex-parse.ts`, `claude-parse.ts`), so nothing mutable escapes.
 */
export interface ParseState {
  /** Turn-abort events seen, counted even when the turn's detail record was not retained. */
  abortedTurns: number;
  /** Per-call rows, allocated only when the caller asked for call-level detail. */
  readonly calls: SessionToolCall[] | undefined;
  readonly commands: Map<string, MutableCommandUsage>;
  compactions: number;
  /** Turn-completion events seen, counted even when the turn's detail record was not retained. */
  completedTurns: number;
  /** The model's context window in tokens, as of the last usage record that named it. */
  contextWindow: number | undefined;
  cwd: string | undefined;
  /** Files touched across recorded patch applications. */
  editFiles: number;
  editsApplied: number;
  editsFailed: number;
  endedAt: string | undefined;
  firstMs: number | undefined;
  git: SessionGitContext;
  /** 1-based validation attempt that first passed, once one has. */
  greenIteration: number | undefined;
  /** Prompt tokens of the first recorded request: what the harness preloaded into the window. */
  initialContextTokens: number | undefined;
  initialPromptChars: number;
  readonly initialPromptLines: number[];
  /** Present numeric fields rejected because they were outside their semantic bounds. */
  invalidValues: number;
  internalApprovalReview: boolean;
  readonly interventions: SessionIntervention[];
  largestToolOutputChars: number;
  lastMs: number | undefined;
  model: string | undefined;
  /** Non-empty JSONL records that were not valid JSON objects. */
  malformedLines: number;
  openTurn: MutableTurn | undefined;
  readonly outcomes: ToolOutcome[];
  /** Largest single recorded request, prompt plus output tokens. */
  peakRequestTokens: number;
  readonly pending: Map<string, PendingCall>;
  promptOpen: boolean;
  /** GitHub pull-request URLs seen in successful `gh` outputs. */
  readonly pullRequests: Set<string>;
  quota: SessionQuota | undefined;
  /** Records that looked like the source's; zero means the file was not a session transcript. */
  recognized: number;
  sessionId: string | undefined;
  /** Original shell calls whose process is still running and will be polled by `write_stdin`. */
  readonly shellSessions: Map<string, PendingCall>;
  startedAt: string | undefined;
  tokens: SessionTokenUsage | undefined;
  /** Cumulative token totals as last reported before the first green validation run. */
  tokensAtFirstGreen: SessionTokenUsage | undefined;
  readonly tools: Map<string, MutableToolUsage>;
  toolOutputChars: number;
  readonly turnById: Map<string, MutableTurn>;
  readonly turnList: MutableTurn[];
  turns: number;
  turnsTruncated: boolean;
  userMessages: number;
  validationAttempts: number;
  validationFailures: number;
  validationTimeMs: number;
  /** Issue keys found in prompts, branch names, and git/gh commands. */
  readonly workItems: Set<string>;
}

/** A tool call whose result record has not been seen yet. */
export interface PendingCall {
  readonly at: number | undefined;
  readonly batchComponents: readonly ShellBatchComponent[] | undefined;
  readonly callId: string | undefined;
  readonly callLine: number;
  readonly command: string | undefined;
  readonly label: string;
  readonly shellSessionId: string | undefined;
  readonly startedAt: string | undefined;
  readonly subcommand: string | undefined;
  readonly tool: string;
  readonly turnIndex: number | undefined;
}

/** One turn being folded; copied into a `SessionTurn` when the session finishes. */
export interface MutableTurn {
  closed: SessionTurnClose | undefined;
  durationMs: number | undefined;
  endMs: number | undefined;
  endedAt: string | undefined;
  readonly index: number;
  model: string | undefined;
  startMs: number | undefined;
  startedAt: string | undefined;
  timeToFirstTokenMs: number | undefined;
  tokens: MutableTokenUsage | undefined;
  toolCalls: number;
  toolTimeMs: number;
  turnId: string | undefined;
}

export interface MutableTokenUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface MutableToolUsage {
  calls: number;
  durationMs: number;
  failures: number;
}

interface MutableCommandUsage {
  calls: number;
  readonly command: string | undefined;
  durationMs: number;
  failures: number;
  readonly subcommand: string | undefined;
  readonly tool: string;
}

/** Folds the record's timestamp into the session's span and returns it as epoch milliseconds. */
export function trackRecordTime(
  state: ParseState,
  timestamp: string | undefined,
): number | undefined {
  const at = timestamp === undefined ? undefined : utcTimestampMs(timestamp);
  if (at === undefined || timestamp === undefined) {
    return undefined;
  }
  if (state.firstMs === undefined || at < state.firstMs) {
    state.firstMs = at;
    state.startedAt = timestamp;
  }
  if (state.lastMs === undefined || at > state.lastMs) {
    state.lastMs = at;
    state.endedAt = timestamp;
  }
  return at;
}

/** The usage bucket for one tool, created on first sight. */
export function usage(tools: Map<string, MutableToolUsage>, tool: string): MutableToolUsage {
  const existing = tools.get(tool);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableToolUsage = { calls: 0, durationMs: 0, failures: 0 };
  tools.set(tool, created);
  return created;
}

export function sumToolTime(tools: ReadonlyMap<string, MutableToolUsage>): number {
  let total = 0;
  for (const used of tools.values()) {
    total = boundedAdd(total, used.durationMs);
  }
  return total;
}

/** The call bucket for one (tool, command, subcommand) identity, created on first sight. */
export function commandUsage(
  commands: Map<string, MutableCommandUsage>,
  identity: CommandIdentity,
): MutableCommandUsage {
  const key = commandKey(identity);
  const existing = commands.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableCommandUsage = {
    calls: 0,
    command: identity.command,
    durationMs: 0,
    failures: 0,
    subcommand: identity.subcommand,
    tool: identity.tool,
  };
  commands.set(key, created);
  return created;
}

/** Backs out one provisional call, deleting a bucket the retraction leaves empty. */
export function releaseCommandUsage(
  commands: Map<string, MutableCommandUsage>,
  identity: CommandIdentity,
): void {
  const key = commandKey(identity);
  const bucket = commands.get(key);
  if (bucket === undefined) {
    return;
  }
  bucket.calls = Math.max(bucket.calls - 1, 0);
  if (bucket.calls === 0 && bucket.durationMs === 0 && bucket.failures === 0) {
    commands.delete(key);
  }
}

/** Copies the call buckets out of the accumulator, busiest first, deterministically ordered. */
export function finishCommands(
  commands: ReadonlyMap<string, MutableCommandUsage>,
): readonly SessionCommandUsage[] {
  const rows = [...commands.values()].map((bucket) => ({
    ...bucket,
    validation: isValidationIdentity(bucket.command, bucket.subcommand),
  }));
  rows.sort((a, b) => {
    if (a.calls !== b.calls) {
      return b.calls - a.calls;
    }
    if (a.durationMs !== b.durationMs) {
      return b.durationMs - a.durationMs;
    }
    const left = commandKey(a);
    const right = commandKey(b);
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
  return rows;
}

export function finishEdits(state: ParseState): SessionEditMetrics | undefined {
  if (state.editsApplied === 0 && state.editsFailed === 0) {
    return undefined;
  }
  return { applied: state.editsApplied, failed: state.editsFailed, files: state.editFiles };
}

export function finishValidation(state: ParseState): SessionValidationMetrics | undefined {
  if (state.validationAttempts === 0) {
    return undefined;
  }
  return {
    attempts: state.validationAttempts,
    failures: state.validationFailures,
    iterationsToFirstGreen: state.greenIteration,
    timeMs: state.validationTimeMs,
    tokensAtFirstGreen: state.tokensAtFirstGreen,
  };
}

export function finishContext(state: ParseState): SessionContextMetrics | undefined {
  if (
    state.contextWindow === undefined &&
    state.initialContextTokens === undefined &&
    state.peakRequestTokens === 0
  ) {
    return undefined;
  }
  return {
    initialContextTokens: state.initialContextTokens,
    modelContextWindow: state.contextWindow,
    peakRequestTokens: state.peakRequestTokens,
  };
}

/** NUL-joined so a command containing spaces (`shell batch`) cannot collide with another key. */
function commandKey(identity: CommandIdentity): string {
  return [identity.tool, identity.command ?? "", identity.subcommand ?? ""].join("\u0000");
}
