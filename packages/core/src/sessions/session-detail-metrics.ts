import type { OutcomeConfidence, SessionTokenUsage } from "./session-metrics.js";

/**
 * Turn- and call-level detail extracted from one recorded agent session.
 *
 * Split from `session-metrics.ts` only for the file-size cap; the two files describe one result
 * shape. Everything here is best-effort: a transcript that never recorded a signal yields
 * `undefined`, never a guess.
 */

/** The application that recorded a session transcript. */
export type SessionSource = "codex" | "claude-code";

/** How much per-call material a parse retains beyond the always-present aggregates. */
export type SessionDetailLevel = "summary" | "calls";

/** How a turn's record span ended in the transcript. */
export type SessionTurnClose = "completed" | "aborted" | "log-end";

/** One prompt-to-completion round, in transcript order. */
export interface SessionTurn {
  /** Whether the agent finished, a person aborted it, or the log ended mid-turn. */
  readonly closed: SessionTurnClose;
  /** The harness-reported turn duration when one was recorded, else the record-span length. */
  readonly durationMs: number;
  readonly endedAt: string | undefined;
  /** Position of the turn's start within the session, 0-based. */
  readonly index: number;
  /** The model the harness reported for this turn, when it reported one. */
  readonly model: string | undefined;
  readonly startedAt: string | undefined;
  readonly timeToFirstTokenMs: number | undefined;
  /** Token deltas summed over the turn's recorded requests, when the harness reported them. */
  readonly tokens: SessionTokenUsage | undefined;
  readonly toolCalls: number;
  /** Wall-clock milliseconds this turn spent waiting on tool calls. */
  readonly toolTimeMs: number;
  readonly turnId: string | undefined;
}

/** Calls folded by (tool, command, subcommand), so `git diff` and `git push` stay distinct. */
export interface SessionCommandUsage {
  readonly calls: number;
  /** Bare executable name for shell calls (`git`, `shell batch`), absent for other tools. */
  readonly command: string | undefined;
  readonly durationMs: number;
  readonly failures: number;
  /** First subcommand token for executables known to route through one (`diff`, `test`). */
  readonly subcommand: string | undefined;
  readonly tool: string;
  /** Whether the identity is a recognized validation command (tests, lint, build, typecheck). */
  readonly validation: boolean;
}

/** File-edit outcomes the harness recorded as patch applications. */
export interface SessionEditMetrics {
  /** Patch applications that succeeded. */
  readonly applied: number;
  readonly failed: number;
  /** Files touched across all recorded patch applications. */
  readonly files: number;
}

/** What the session spent on validation commands, and where the first green run landed. */
export interface SessionValidationMetrics {
  /** Validation calls that recorded a result. */
  readonly attempts: number;
  readonly failures: number;
  /** 1-based attempt number of the first passing validation run, absent when none passed. */
  readonly iterationsToFirstGreen: number | undefined;
  /** Wall-clock milliseconds spent waiting on validation commands. */
  readonly timeMs: number;
  /** Cumulative session token totals as last reported before the first green run. */
  readonly tokensAtFirstGreen: SessionTokenUsage | undefined;
}

/** One recorded tool call. Retained only when the caller asked for call-level detail. */
export interface SessionToolCall {
  readonly callId: string | undefined;
  readonly callLine: number;
  readonly command: string | undefined;
  readonly durationMs: number | undefined;
  readonly exitCode: number | undefined;
  readonly outputChars: number;
  readonly startedAt: string | undefined;
  /** `unpaired` means the call's result record never appeared in the transcript. */
  readonly status: "ok" | "failure" | "unpaired";
  readonly subcommand: string | undefined;
  readonly tool: string;
  /** The turn the call belongs to, when the transcript recorded turn boundaries. */
  readonly turnIndex: number | undefined;
}

/** A moment where a person steered the session instead of waiting for it. */
export interface SessionIntervention {
  readonly kind: "interrupt" | "reprompt" | "approval" | "denial";
  readonly line: number;
  readonly turnIndex: number | undefined;
}

/** A best-effort read of how the session ended, never presented as ground truth. */
export interface SessionOutcomeInference {
  readonly confidence: OutcomeConfidence;
  readonly status: "completed_autonomously" | "completed_with_help" | "abandoned";
}

/** Sessions joined by one issue key they mentioned: the loose work-item association. */
export interface WorkItemAggregate {
  /** Earliest recorded session start among the sessions naming this key. */
  readonly firstSeen: string | undefined;
  readonly key: string;
  /** Latest recorded session end among the sessions naming this key. */
  readonly lastSeen: string | undefined;
  readonly sessions: number;
  /** Milliseconds between the first start and the last end, a rough task-elapsed signal. */
  readonly spanMs: number;
  /** Agent wall-clock milliseconds summed over the sessions naming this key. */
  readonly wallClockMs: number;
}

/** How much of the model's context window the session actually used. */
export interface SessionContextMetrics {
  /** Prompt tokens of the session's first recorded request: the preloaded context cost. */
  readonly initialContextTokens: number | undefined;
  readonly modelContextWindow: number | undefined;
  /** Largest single request, prompt plus output tokens: the session's peak window occupancy. */
  readonly peakRequestTokens: number;
}
