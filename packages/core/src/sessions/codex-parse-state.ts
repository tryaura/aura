import type {
  SessionGitContext,
  SessionQuota,
  SessionTokenUsage,
  ToolOutcome,
} from "./session-metrics.js";

/**
 * The accumulator one Codex transcript parse folds its records into.
 *
 * Mutable on purpose: the parser walks a line-delimited log once, and the public result is copied
 * out of this state at the end (`codex-parse.ts`), so nothing mutable escapes.
 */
export interface ParseState {
  compactions: number;
  cwd: string | undefined;
  endedAt: string | undefined;
  firstMs: number | undefined;
  git: SessionGitContext;
  initialPromptChars: number;
  readonly initialPromptLines: number[];
  largestToolOutputChars: number;
  lastMs: number | undefined;
  readonly outcomes: ToolOutcome[];
  readonly pending: Map<string, PendingCall>;
  promptOpen: boolean;
  quota: SessionQuota | undefined;
  /** Records that looked like Codex's; zero means the file was not a session transcript. */
  recognized: number;
  sessionId: string | undefined;
  /** Original shell calls whose process is still running and will be polled by `write_stdin`. */
  readonly shellSessions: Map<string, PendingCall>;
  startedAt: string | undefined;
  tokens: SessionTokenUsage | undefined;
  readonly tools: Map<string, MutableToolUsage>;
  toolOutputChars: number;
  turns: number;
  userMessages: number;
}

/** A tool call whose result record has not been seen yet. */
export interface PendingCall {
  readonly at: number | undefined;
  readonly callLine: number;
  readonly command: string | undefined;
  readonly label: string;
  readonly shellSessionId: string | undefined;
  readonly tool: string;
}

export interface MutableToolUsage {
  calls: number;
  durationMs: number;
  failures: number;
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
    total += used.durationMs;
  }
  return total;
}
