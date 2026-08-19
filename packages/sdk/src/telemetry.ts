/** The CLI subcommand a telemetry event describes. */
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

/** Findings one check produced, counted by severity. Clean checks appear in `passedCheckIds`. */
export interface TelemetryCheckFindings {
  readonly checkId: string;
  readonly errors: number;
  readonly informational: number;
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
  readonly counts: TelemetryCheckCounts;
  readonly diagnosticCount: number;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly findings: readonly TelemetryCheckFindings[];
  readonly flags: TelemetryCheckFlags;
  readonly kind: "check-run";
  readonly passedCheckIds: readonly string[];
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
 * The desired state a setup run planned or applied.
 *
 * Catalog MCP servers and bundled skills use distribution-owned identifiers. Custom servers and
 * externally sourced skills are counted rather than named because their metadata is user- or
 * service-authored text.
 */
export interface TelemetryManifestSummary {
  readonly managedAppIds: readonly string[];
  readonly mcpServers: {
    readonly catalogIds: readonly string[];
    readonly customCount: number;
  };
  readonly skills: {
    readonly bundled: readonly {
      readonly id: string;
      readonly source: `plugin:${string}`;
      readonly version: string;
    }[];
    readonly externalCount: number;
  };
  readonly snippets: readonly { readonly id: string; readonly version: string }[];
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
  /** Operations written to disk. Present only when the outcome is `applied`. */
  readonly appliedOperationCount?: number | undefined;
  readonly command: "setup";
  readonly durationMs: number;
  readonly exitCode: number;
  readonly kind: "setup-run";
  /** Present whenever the run produced a plan, including outcomes that wrote nothing. */
  readonly manifest?: TelemetryManifestSummary | undefined;
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

/** Everything Aura reports about a run, as a closed union a sink can switch over. */
export type TelemetryEvent =
  | CheckRunEvent
  | CommandFailedEvent
  | FixRunEvent
  | SetupRunEvent
  | UndoRunEvent;

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
