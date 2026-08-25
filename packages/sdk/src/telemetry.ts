/**
 * The built-in CLI subcommand a telemetry event describes.
 *
 * A {@link DistroCommandEvent} carries its own registered word instead, which is why the envelope's
 * `command` is narrowed per event rather than once for the whole union.
 */
export type TelemetryCommand = "check" | "setup" | "undo";

/**
 * Fields the CLI stamps onto every event before it reaches a sink.
 *
 * Payloads contain fixed vocabulary, counts, booleans, durations, and identifiers owned by the
 * distribution — never filesystem paths, file contents, finding messages, display names,
 * environment values, or strings returned by external tools and directories. New event fields must
 * hold to the same rule.
 */
export interface TelemetryEnvelope {
  /** ISO-8601 time the event was recorded, from the injected clock. */
  readonly at: string;
  /** The subcommand that produced the event. */
  readonly command: TelemetryCommand;
  /** The distribution's version; absent when the distribution declares none. */
  readonly distroVersion?: string | undefined;
}

/** One agent application, as the run's report saw it. */
export interface TelemetryAppState {
  /** Stable adapter identifier, such as `"claude-code"`. */
  readonly appId: string;
  /** Whether detection found the application installed. */
  readonly installed: boolean;
}

/**
 * The result of one executed check, counted by severity.
 *
 * `failed` means the check threw and produced nothing, which is why every count is zero there and
 * cannot be told apart from `passed` by the counts alone.
 */
export interface TelemetryCheckState {
  readonly checkId: string;
  readonly errors: number;
  readonly informational: number;
  readonly state: "failed" | "findings" | "passed";
  readonly warnings: number;
}

/** Whole-run totals, mirroring the check report's summary counts. */
export interface TelemetryCheckCounts {
  readonly errors: number;
  readonly informational: number;
  readonly passed: number;
  readonly warnings: number;
}

/** Options the user passed to a check run, so a sink can segment interactive and scripted use. */
export interface TelemetryCheckFlags {
  readonly dryRun: boolean;
  readonly fix: boolean;
  readonly interactive: boolean;
  readonly json: boolean;
  readonly online: boolean;
  readonly verbose: boolean;
}

/** One completed `check` run. */
export interface CheckRunEvent extends TelemetryEnvelope {
  readonly apps: readonly TelemetryAppState[];
  readonly command: "check";
  /** Every executed check, ordered by check ID, including ones that passed or failed to run. */
  readonly checks: readonly TelemetryCheckState[];
  readonly counts: TelemetryCheckCounts;
  readonly diagnosticCount: number;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly flags: TelemetryCheckFlags;
  readonly kind: "check-run";
}

/** How one finding's fix ended, identified by the check that owns it. */
export interface TelemetryFixOutcome {
  readonly checkId: string;
  readonly status: "applied" | "failed" | "partial" | "planned";
}

/** Emitted alongside {@link CheckRunEvent} whenever a run carried `--fix`. */
export interface FixRunEvent extends TelemetryEnvelope {
  readonly command: "check";
  readonly dryRun: boolean;
  readonly exitCode: number;
  readonly fixes: readonly TelemetryFixOutcome[];
  readonly interactive: boolean;
  readonly kind: "fix-run";
}

/**
 * The privacy-safe choices one setup run planned or applied.
 *
 * Catalog MCP servers and bundled skills use distribution-owned identifiers. Custom servers and
 * externally sourced skills are counted rather than named because their metadata is user- or
 * service-authored text.
 *
 * Absent and empty mean different things, and the distinction is the point of every field being
 * optional: an absent field means the run never offered that category — the step did not run, or
 * ran with nothing to show — while an empty one means the user was asked and chose nothing. Only
 * the second belongs in the denominator of an adoption rate.
 */
export interface TelemetrySetupActions {
  /** Adapter ids selected in the Applications step. */
  readonly applications?: readonly string[] | undefined;
  /** Handling selected for each instruction scope the Instructions step offered. */
  readonly instructions?: readonly TelemetryInstructionAction[] | undefined;
  /** Servers selected in the MCP step: catalog ids by name, everything else counted. */
  readonly mcpServers?:
    | {
        readonly catalogIds: readonly string[];
        readonly customCount: number;
      }
    | undefined;
  /** Skills selected in the Skills step: bundled plugin skills by id, external ones counted. */
  readonly skills?:
    | {
        readonly bundled: readonly {
          readonly id: string;
          readonly source: `plugin:${string}`;
        }[];
        readonly externalCount: number;
      }
    | undefined;
  /** Distribution-owned ids selected in the Snippets step. */
  readonly snippets?: readonly string[] | undefined;
}

/**
 * The handling selected for personal instructions during setup.
 *
 * No scope travels with it. Aura consolidates one target, so a scope field would be the same
 * constant on every event ever sent, which is a column that cannot answer a question.
 */
export interface TelemetryInstructionAction {
  readonly action: "blocked" | "consolidate" | "keep" | "template";
}

/** How a completed setup flow ended. Unexpected throws emit `command-failed` instead. */
export type SetupRunOutcome =
  /** The wizard was abandoned before confirmation. */
  | "aborted"
  /** The plan was confirmed and written. */
  | "applied"
  /** Conflicts or blockers prevented a write. */
  | "blocked"
  /** The desired state was already on disk; nothing to write. */
  | "converged"
  /** The user answered no at the confirmation. */
  | "declined"
  /** `--dry-run` stopped the run at the plan. */
  | "dry-run"
  /** The run could not start: read-only manifest state or an invalid preset. */
  | "unusable";

/** One completed `setup` run. */
export interface SetupRunEvent extends TelemetryEnvelope {
  /** Final privacy-safe choices. Present only after setup produced a plan. */
  readonly actions?: TelemetrySetupActions | undefined;
  /** Operations written to disk. Present only when the outcome is `applied`. */
  readonly appliedOperationCount?: number | undefined;
  readonly command: "setup";
  readonly durationMs: number;
  readonly exitCode: number;
  readonly kind: "setup-run";
  readonly outcome: SetupRunOutcome;
}

/** How an undo run ended. */
export type UndoRunOutcome =
  /** The user answered no at the confirmation. */
  | "declined"
  /** `--dry-run` previewed the restore without writing. */
  | "dry-run"
  /** The restore was attempted and failed. */
  | "failed"
  /** `--list` printed the available backups. */
  | "listed"
  /** No backup was available to restore. */
  | "nothing-to-undo"
  /** A named backup was missing, unreadable, or not undoable. */
  | "refused"
  /** The backup was restored. */
  | "restored";

/** One completed `undo` run. */
export interface UndoRunEvent extends TelemetryEnvelope {
  readonly command: "undo";
  readonly exitCode: number;
  readonly kind: "undo-run";
  readonly outcome: UndoRunOutcome;
  /** Operations restored. Present only when the outcome is `restored`. */
  readonly restoredOperationCount?: number | undefined;
  /** Newer backups skipped over to reach the named one. Present only when `restored`. */
  readonly skippedBackupCount?: number | undefined;
}

/**
 * An unexpected operational failure in any command.
 *
 * Deliberately carries no error text: failure messages can echo paths or file contents.
 */
export interface CommandFailedEvent extends TelemetryEnvelope {
  readonly exitCode: number;
  readonly kind: "command-failed";
}

/**
 * One event recorded by a command a distribution registered of its own.
 *
 * The envelope is stamped by the CLI, so a command can neither omit it nor attribute an event to
 * another command. The payload carries the same closed vocabulary every built-in event does:
 * distribution-owned labels, counts, booleans, and durations. `event` and `outcome` are labels the
 * distribution chose at build time — never text read from a file, a tool, or the user.
 */
export interface DistroCommandEvent extends Omit<TelemetryEnvelope, "command"> {
  /** The registered command word the event belongs to, stamped by the CLI. */
  readonly command: string;
  /** Distribution-owned counters, keyed by label. */
  readonly counts?: Readonly<Record<string, number>> | undefined;
  /** Milliseconds the measured work took. */
  readonly durationMs?: number | undefined;
  /**
   * What happened, as a distribution-owned label such as `sync-run`. The CLI reserves
   * `command-failed`, which it records itself when a command throws.
   */
  readonly event: string;
  /** Exit code, present when the event describes a finished run. */
  readonly exitCode?: number | undefined;
  /** Distribution-owned booleans, keyed by label — typically which options the run carried. */
  readonly flags?: Readonly<Record<string, boolean>> | undefined;
  readonly kind: "distro-command";
  /** Fixed-vocabulary outcome owned by the distribution, such as `applied`. */
  readonly outcome?: string | undefined;
}

/** Everything Aura reports about a run, as a closed union a sink can switch over. */
export type TelemetryEvent =
  | CheckRunEvent
  | CommandFailedEvent
  | DistroCommandEvent
  | FixRunEvent
  | SetupRunEvent
  | UndoRunEvent;

/** The versioned payload delivered by Aura's built-in HTTP telemetry sink. */
export interface TelemetryBatchV1 {
  readonly events: readonly TelemetryEvent[];
  readonly kind: "aura-telemetry";
  readonly schemaVersion: 1;
}

/**
 * Where a distribution sends run events. Left unset on {@link CliDistro}, telemetry is a no-op.
 *
 * `record` sits on the command path: it must buffer and return immediately, and should not throw
 * — the CLI swallows throws regardless, so a sink can never fail a run, and it must never write to
 * the process streams. `flush` is called once as the run ends and is bounded by the CLI to roughly
 * two seconds. The signal passed to `flush` aborts at that deadline; implementations must stop
 * their I/O when it fires so undelivered work cannot keep the process open.
 */
export interface TelemetrySink {
  readonly flush: (signal: AbortSignal) => Promise<void>;
  readonly record: (event: TelemetryEvent) => void;
}
