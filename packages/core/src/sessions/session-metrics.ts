/**
 * Metrics extracted from one recorded agent session transcript.
 *
 * A transcript is another application's private log: undocumented, versioned only implicitly, and
 * free to change shape between releases. Every field here is therefore best-effort — absent when
 * the transcript did not carry it — and the extractor never fails a whole analysis over one
 * malformed line or file.
 */

/** Subscription-quota state an agent reported, as of the session's last usage record. */
export interface SessionQuota {
  /** The subscription plan name, e.g. `pro`. */
  readonly planType?: string | undefined;
  /** How much of the plan's rolling window was used, 0–100. */
  readonly usedPercent: number;
  /** Length of the rolling window in minutes, e.g. 10080 for seven days. */
  readonly windowMinutes?: number | undefined;
}

/** Token totals an agent reported for one session, as of its last usage record. */
export interface SessionTokenUsage {
  /** Input tokens served from the provider's prompt cache. */
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A conservative interpretation of a recorded non-success tool outcome. */
export type OutcomeKind =
  | "check_failure"
  | "invocation_error"
  | "no_match"
  | "pending_status"
  | "tool_error"
  | "unknown_nonzero";

export type OutcomeConfidence = "high" | "medium" | "low";

/** Historical repository identity recorded when a session started. */
export interface SessionGitContext {
  readonly branch: string | undefined;
  readonly commitHash: string | undefined;
  readonly repositoryUrl: string | undefined;
}

/** One non-success tool result, paired with the call that produced it. */
export interface ToolOutcome {
  readonly callLine: number;
  readonly confidence: OutcomeConfidence;
  readonly exitCode: number | undefined;
  readonly kind: OutcomeKind;
  /** Safe, bounded identity: a simple executable, `shell batch`, or an MCP tool name. */
  readonly label: string;
  readonly reason: string;
  readonly resultLine: number;
  readonly tool: string;
}

/** How one tool was used across a session. */
interface SessionToolUsage {
  readonly calls: number;
  /** Wall-clock milliseconds between each call and its recorded result, summed. */
  readonly durationMs: number;
  readonly failures: number;
}

/** What one session transcript yielded. */
export interface AgentSessionMetrics {
  /** Context compaction events: each one means the session outgrew its window. */
  readonly compactions: number;
  /** Working directory the session ran in, used to group sessions by repository. */
  readonly cwd: string | undefined;
  readonly endedAt: string | undefined;
  /** Historical git state recorded by Codex when the session began. */
  readonly git: SessionGitContext;
  /** Characters in the initial system/developer/user prompt before the first tool call. */
  readonly initialPromptChars: number;
  /** Transcript lines carrying that initial prompt, so historical instructions remain inspectable. */
  readonly initialPromptLines: readonly number[];
  /** Largest single recorded tool output in characters. */
  readonly largestToolOutputChars: number;
  /** Classified non-success outcomes from shell and MCP tools. */
  readonly outcomes: readonly ToolOutcome[];
  /** The account's quota state when the session last reported usage, when it reported one. */
  readonly quota?: SessionQuota;
  readonly sessionId: string | undefined;
  /** The application that recorded the transcript. */
  readonly source: "codex";
  readonly startedAt: string | undefined;
  readonly tokens: SessionTokenUsage | undefined;
  /** Wall-clock milliseconds spent waiting on tool calls, summed across all tools. */
  readonly toolTimeMs: number;
  /** Total characters returned by tools. Useful when investigating compaction pressure. */
  readonly toolOutputChars: number;
  readonly tools: Readonly<Record<string, SessionToolUsage>>;
  /** Absolute path of the transcript this came from. Set by the analyzer, not the parser. */
  readonly transcriptPath?: string;
  /** Whether the transcript was larger than the read limit, making every count a lower bound. */
  readonly truncated: boolean;
  /** Prompt-to-completion rounds the agent recorded. */
  readonly turns: number;
  readonly userMessages: number;
  /** Milliseconds between the first and last transcript entry. */
  readonly wallClockMs: number;
}

/** Paired call/result evidence with the historical session context needed to interpret it. */
export interface OutcomeEvidence {
  readonly branch: string | undefined;
  readonly callLine: number;
  readonly commitHash: string | undefined;
  readonly cwd: string | undefined;
  readonly file: string;
  readonly initialPromptChars: number;
  readonly initialPromptLines: readonly number[];
  readonly resultLine: number;
  readonly sessionId: string | undefined;
}

/** One recurring classified outcome and representative evidence for it. */
export interface OutcomeCount {
  readonly confidence: OutcomeConfidence;
  readonly count: number;
  readonly exemplars: readonly OutcomeEvidence[];
  readonly exitCode: number | undefined;
  readonly kind: OutcomeKind;
  readonly label: string;
  readonly reason: string;
}

/** Session-level signals that can support, but never prove, a compaction hypothesis. */
export interface CompactionProfile {
  readonly compactedSessions: number;
  readonly compactedInitialPromptCharsAverage: number;
  readonly compactedToolOutputCharsAverage: number;
  readonly compactedTurnsAverage: number;
  readonly cleanSessions: number;
  readonly cleanInitialPromptCharsAverage: number;
  readonly cleanToolOutputCharsAverage: number;
  readonly cleanTurnsAverage: number;
}

/** One working directory inside a project where trouble concentrates. */
export interface DirectoryHotspot {
  readonly compactions: number;
  readonly cwd: string;
  readonly failedToolCalls: number;
  readonly sessions: number;
}

/** Sessions of one project, summed across its working directories. */
export interface RepoSessionAggregate {
  readonly checkFailures: number;
  readonly compactionProfile: CompactionProfile;
  readonly compactions: number;
  /** Distinct working directories collapsed into this project. */
  readonly directories: number;
  readonly failedToolCalls: number;
  /** Directories where failures or compactions concentrate, worst first. At most three. */
  readonly hotspots: readonly DirectoryHotspot[];
  /**
   * What to call the project: the repository name when one resolved, otherwise the shared
   * working directory path. A path label starts with a separator; a name does not.
   */
  readonly project: string;
  /** Expected protocol statuses such as pending CI or a no-match search. */
  readonly expectedStatuses: number;
  /** Missing executables and MCP errors: failures of the execution environment itself. */
  readonly operationalFailures: number;
  /** Classified outcome groups, most frequent first. At most five. */
  readonly outcomeCounts: readonly OutcomeCount[];
  /** Distinct outcome groups before the brief/report presentation cap. */
  readonly outcomeGroupCount: number;
  readonly sessions: number;
  readonly tokens: SessionTokenUsage;
  readonly toolCalls: number;
  readonly toolTimeMs: number;
  readonly truncatedSessions: number;
  readonly unknownOutcomes: number;
  readonly wallClockMs: number;
}

/** The result of scanning every discovered transcript in the window. */
export interface SessionAnalysis {
  /** Per-project sums, most sessions first. */
  readonly repos: readonly RepoSessionAggregate[];
  /** Transcript files that existed in the window, readable or not. */
  readonly scannedFiles: number;
  readonly sessions: readonly AgentSessionMetrics[];
  /** Start of the analysis window as a `YYYY-MM-DD` day key. */
  readonly since: string;
  /** Files that could not be read or held no parseable session. */
  readonly unreadableFiles: number;
}
