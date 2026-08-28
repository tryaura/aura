import type {
  SessionCommandUsage,
  SessionContextMetrics,
  SessionEditMetrics,
  SessionIntervention,
  SessionOutcomeInference,
  SessionSource,
  SessionToolCall,
  SessionTurn,
  SessionValidationMetrics,
  WorkItemAggregate,
} from "./session-detail-metrics.js";

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
  /** Credential-free repository remote metadata. URL userinfo is removed during parsing. */
  readonly repositoryUrl: string | undefined;
}

/** One privacy-safe executable identity found inside a compound shell call. */
export interface ShellBatchComponent {
  readonly command: string;
  readonly subcommand: string | undefined;
}

/** How often one executable identity appeared across a group of compound shell calls. */
export interface ShellBatchComponentCount extends ShellBatchComponent {
  readonly count: number;
}

/** One non-success tool result, paired with the call that produced it. */
export interface ToolOutcome {
  /** Executable identities observed in a shell batch; this does not identify the failing segment. */
  readonly batchComponents?: readonly ShellBatchComponent[];
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
  readonly agentTimeMs: number;
  /** Turn-abort events the transcript recorded, whether or not their turn detail was retained. */
  readonly abortedTurns: number;
  /** One row per recorded tool call. Present only when the caller asked for call detail. */
  readonly calls?: readonly SessionToolCall[];
  /** Call totals folded by (tool, command, subcommand), busiest first. */
  readonly commands: readonly SessionCommandUsage[];
  /** Context compaction events: each one means the session outgrew its window. */
  readonly compactions: number;
  /** Turn-completion events the transcript recorded. */
  readonly completedTurns: number;
  /** Context-window occupancy, when the transcript reported per-request token usage. */
  readonly context: SessionContextMetrics | undefined;
  /** Working directory the session ran in, used to group sessions by repository. */
  readonly cwd: string | undefined;
  /** Recorded patch-application outcomes, when the transcript carried any. */
  readonly edits: SessionEditMetrics | undefined;
  readonly endedAt: string | undefined;
  /** Historical git state recorded by Codex when the session began. */
  readonly git: SessionGitContext;
  /** How the session appears to have ended. Inference from turn closes, never ground truth. */
  readonly inferredOutcome: SessionOutcomeInference | undefined;
  /** Characters in the initial system/developer/user prompt before the first tool call. */
  readonly initialPromptChars: number;
  /** Transcript lines carrying that initial prompt, so historical instructions remain inspectable. */
  readonly initialPromptLines: readonly number[];
  /** Present numeric fields discarded because they were outside their semantic bounds. */
  readonly invalidValues: number;
  /** Moments where a person interrupted or re-prompted the agent, in transcript order. */
  readonly interventions: readonly SessionIntervention[];
  /** Largest single recorded tool output in characters. */
  readonly largestToolOutputChars: number;
  /** Non-empty JSONL records that were not valid JSON objects. */
  readonly malformedLines: number;
  /** The model the session last reported, when the transcript carried one. */
  readonly model: string | undefined;
  /** Classified non-success outcomes from shell and MCP tools. */
  readonly outcomes: readonly ToolOutcome[];
  /** GitHub pull-request URLs seen in successful `gh` outputs, deduplicated and capped. */
  readonly pullRequests: readonly string[];
  /** The account's quota state when the session last reported usage, when it reported one. */
  readonly quota?: SessionQuota;
  readonly sessionId: string | undefined;
  /** The application that recorded the transcript. */
  readonly source: SessionSource;
  readonly startedAt: string | undefined;
  readonly tokens: SessionTokenUsage | undefined;
  /** Wall-clock milliseconds spent waiting on tool calls, summed across all tools. */
  readonly toolTimeMs: number;
  /** Total characters returned by tools. Useful when investigating compaction pressure. */
  readonly toolOutputChars: number;
  readonly tools: Readonly<Record<string, SessionToolUsage>>;
  /** Absolute path of the transcript this came from. Set by the analyzer, not the parser. */
  readonly transcriptPath?: string;
  /** Whether truncation, malformed input, invalid values, or an I/O failure made counts incomplete. */
  readonly partial: boolean;
  /** Whether the requested transcript prefix could not be read to completion. */
  readonly readError: boolean;
  /** Whether the transcript was larger than the read limit, making every count a lower bound. */
  readonly truncated: boolean;
  /** Per-turn detail in transcript order, capped so one runaway session stays bounded. */
  readonly turnDetails: readonly SessionTurn[];
  /** Prompt-to-completion rounds the agent recorded. */
  readonly turns: number;
  /** Whether the session had more turns than `turnDetails` retains. */
  readonly turnsTruncated: boolean;
  readonly userMessages: number;
  /** Validation spend and the first green run, when any validation command was recognized. */
  readonly validation: SessionValidationMetrics | undefined;
  /** Milliseconds between the first and last transcript entry. */
  readonly wallClockMs: number;
  /** Issue keys found in prompts, branch names, and git/gh commands, deduplicated and capped. */
  readonly workItems: readonly string[];
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
  /** Distinct component identities before the presentation cap. */
  readonly batchComponentCount?: number;
  /** Most frequent executable identities contained by this shell-batch outcome group. */
  readonly batchComponents?: readonly ShellBatchComponentCount[];
  readonly confidence: OutcomeConfidence;
  readonly count: number;
  readonly exemplars: readonly OutcomeEvidence[];
  readonly exitCode: number | undefined;
  readonly kind: OutcomeKind;
  readonly label: string;
  readonly reason: string;
}

/** One executable the shell could not find, retained outside presentation caps. */
export interface InvocationErrorCount {
  readonly count: number;
  readonly label: string;
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
  readonly agentTimeMs: number;
  /** Turns a person aborted across the project's sessions. */
  readonly abortedTurns: number;
  readonly checkFailures: number;
  readonly compactionProfile: CompactionProfile;
  readonly compactions: number;
  /** Distinct working directories collapsed into this project. */
  readonly directories: number;
  readonly failedToolCalls: number;
  /** Directories where failures or compactions concentrate, worst first. At most three. */
  readonly hotspots: readonly DirectoryHotspot[];
  /** Interrupts, re-prompts, and approvals across the project's sessions. */
  readonly interventions: number;
  readonly invalidValues: number;
  /** Exit-127 outcomes: calls to executables the shell could not find. */
  readonly invocationErrors: number;
  /** Exit-127 outcomes grouped by executable, uncapped for actionable remediation. */
  readonly invocationErrorCounts: readonly InvocationErrorCount[];
  readonly malformedLines: number;
  /** Sessions that ran recognized validation commands and never recorded a passing run. */
  readonly neverGreenSessions: number;
  /** Sessions whose metrics are known lower bounds for any reason. */
  readonly partialSessions: number;
  readonly readErrorSessions: number;
  /**
   * What to call the project: a repository name (qualified on collisions) when one resolved,
   * otherwise the shared working directory path. A path label starts with a separator.
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
  /** Prompt-to-completion rounds across the project's sessions. */
  readonly turns: number;
  readonly unknownOutcomes: number;
  /** Wall-clock milliseconds spent waiting on recognized validation commands. */
  readonly validationTimeMs: number;
  readonly wallClockMs: number;
}

/** The result of scanning every discovered transcript in the window. */
export interface SessionAnalysis {
  /** Present numeric fields discarded across recognized sessions. */
  readonly invalidValues: number;
  /** Malformed non-empty records across recognized sessions. */
  readonly malformedLines: number;
  /** Recognized transcripts whose metrics are known lower bounds. */
  readonly partialFiles: number;
  /** Recognized transcripts whose requested prefix could not be read to completion. */
  readonly readErrorFiles: number;
  /** Per-project sums, most sessions first. */
  readonly repos: readonly RepoSessionAggregate[];
  /** Transcript files that existed in the window, readable or not. */
  readonly scannedFiles: number;
  readonly sessions: readonly AgentSessionMetrics[];
  /** Start of the analysis window as a `YYYY-MM-DD` day key. */
  readonly since: string;
  /** Every harness this analysis read transcripts from. */
  readonly sources: readonly SessionSource[];
  /** Files that could not be read or held no parseable session. */
  readonly unreadableFiles: number;
  /** Sessions joined by the issue keys they mentioned, most sessions first. */
  readonly workItems: readonly WorkItemAggregate[];
}
