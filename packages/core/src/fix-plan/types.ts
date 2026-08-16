import type {
  AuraManifestProblem,
  FileOperation,
  FixPlan,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import type { JournalStatus } from "./journal-schema.js";

/**
 * The filesystem effect represented by one operation preview.
 *
 * `conflict` means the operation cannot run against the current filesystem. It is reported rather
 * than thrown so a preview can still show every other operation in the plan.
 */
export type FixOperationEffect =
  | "conflict"
  | "create"
  | "move"
  | "noop"
  | "remove"
  | "symlink"
  | "update";

/** A rendered, structured preview of one operation in a fix plan. */
export interface FixOperationPreview {
  /** Why the operation cannot run, when `effect` is `conflict`. */
  readonly conflict?: string | undefined;
  /** Deterministic unified diff or metadata-oriented change description. */
  readonly diff: string;
  /** What applying the operation would do against the current filesystem. */
  readonly effect: FixOperationEffect;
  /** Zero-based position in the source plan. */
  readonly index: number;
  /** The original declarative operation. */
  readonly operation: FileOperation;
  /** Every path the operation mutates, in source-plan order. */
  readonly paths: readonly string[];
}

/** A complete fix plan rendered against the current filesystem. */
export interface FixPlanPreview {
  /** Operations that would change the filesystem. Excludes no-ops and conflicts. */
  readonly changedOperationCount: number;
  /** Operations blocked by the current filesystem state. A plan with any of these cannot be applied. */
  readonly conflictedOperationCount: number;
  /** Steps that remain for the user after automated operations finish. */
  readonly manualSteps: readonly string[];
  /** One preview per source operation, including no-ops and conflicts. */
  readonly operations: readonly FixOperationPreview[];
  /** The plugin-authored plan summary. */
  readonly summary: string;
}

/** Inputs required to render a fix plan. */
export interface FixPlanPreviewOptions {
  /**
   * Absolute directories under the home directory a plan may write to.
   *
   * Defaults to the directories the detected adapters declared as global-scope configuration, so
   * the writable surface tracks the applications actually installed. Every entry must sit strictly
   * inside {@link WorkspaceModel.homeDir}; the home directory itself is never an allowed root.
   */
  readonly managedHomeRoots?: readonly string[] | undefined;
  readonly model: WorkspaceModel;
  readonly plan: FixPlan;
}

/** Inputs required to execute or dry-run a fix plan. */
export type FixPlanExecutionOptions = FixPlanPreviewOptions & {
  /** Perform validation and preview reads without mutating the filesystem. */
  readonly dryRun?: boolean | undefined;
  /**
   * Injected clock used to identify the durable backup entry.
   *
   * Required whether or not `dryRun` is set, so that a caller passing a flag it read at runtime does
   * not have to satisfy a different shape depending on the flag's value.
   */
  readonly now: () => Date;
  /** Home used for process-wide Aura state, independent of a command's `--home` override. */
  readonly stateHomeDir?: string | undefined;
};

export interface FixPlanApplyOptions {
  /** Injected clock used to identify the durable backup entry. */
  readonly now: () => Date;
  readonly stateHomeDir?: string | undefined;
}

/** The outcome of executing or dry-running a plan. */
export interface FixPlanExecutionResult {
  /** Operations actually applied. Always zero for a dry run. */
  readonly appliedOperationCount: number;
  /** Durable backup entry created for a mutating execution. */
  readonly backupId?: string | undefined;
  /** Whether filesystem mutation was disabled. */
  readonly dryRun: boolean;
  /** The preview produced immediately before execution. */
  readonly preview: FixPlanPreview;
}

export interface FixPlanUndoOptions {
  /**
   * Undo this entry instead of the most recent one still on disk.
   *
   * Accepts the `backupId` an execution returned, or an ID from {@link FixPlanBackup}.
   */
  readonly backupId?: string | undefined;
  /** Restricts the restore the same way it restricts a plan. See {@link FixPlanPreviewOptions}. */
  readonly managedHomeRoots?: readonly string[] | undefined;
  readonly model: WorkspaceModel;
  /** Injected clock recorded when the journal entry is completed. */
  readonly now: () => Date;
  readonly stateHomeDir?: string | undefined;
}

export interface FixPlanBackupListOptions {
  readonly model: WorkspaceModel;
}

/** One entry in the durable backup store. */
export type FixPlanBackup =
  | {
      readonly createdAt: string;
      readonly id: string;
      readonly operationCount: number;
      readonly status: JournalStatus;
      /** Whether {@link FixPlanUndoOptions.backupId} accepts this ID. */
      readonly undoable: boolean;
    }
  | {
      readonly id: string;
      /** Why the entry could not be read. */
      readonly reason: string;
      readonly status: "unreadable";
      readonly undoable: false;
    };

/** `unreadable` covers an entry left half-written by a killed run, or one this build cannot parse. */
export type FixPlanBackupStatus = FixPlanBackup["status"];

export type FixPlanUndoResult =
  | { readonly status: "nothing-to-undo" }
  | {
      readonly backupId: string;
      readonly restoredOperationCount: number;
      /** Unreadable entries newer than the one undone. Empty in the ordinary case. */
      readonly skippedBackupIds: readonly string[];
      readonly status: "undone";
    };

/** Stable categories callers can use when presenting a rejected fix plan. */
export type FixPlanErrorCode =
  | "backup-error"
  | "filesystem-changed"
  | "filesystem-error"
  | "invalid-options"
  | "invalid-path"
  | "journal-corrupt"
  | "manifest-read-only"
  | "path-conflict"
  | "plan-blocked"
  | "undo-conflict";

/** Extra context attached to a {@link FixPlanError}. */
export interface FixPlanErrorDetails {
  /** The underlying failure, when one exists. Carries the original `errno` code for I/O errors. */
  readonly cause?: unknown;
  /** Why desired state was unusable, on a `manifest-read-only` failure. */
  readonly manifestProblem?: AuraManifestProblem | undefined;
  /** The operation the failure belongs to, when it belongs to one. */
  readonly operationIndex?: number | undefined;
  /** The path the failure concerns. */
  readonly path?: string | undefined;
}

/** A validation or execution failure, usually tied to a particular plan operation. */
export class FixPlanError extends Error {
  readonly code: FixPlanErrorCode;
  /**
   * Why desired state was unusable, present when `code` is `manifest-read-only`.
   *
   * Carried rather than flattened into the message: a newer schema version asks the user to upgrade
   * Aura, while corrupt JSON asks them to repair a file, and a caller cannot tell those apart from
   * prose.
   */
  readonly manifestProblem?: AuraManifestProblem | undefined;
  readonly operationIndex?: number | undefined;
  readonly path?: string | undefined;
  /** The `errno` code of the underlying I/O failure, when the cause was one. */
  readonly systemErrorCode?: string | undefined;

  constructor(code: FixPlanErrorCode, message: string, details: FixPlanErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = "FixPlanError";
    this.code = code;
    this.manifestProblem = details.manifestProblem;
    this.operationIndex = details.operationIndex;
    this.path = details.path;
    this.systemErrorCode = errorCode(details.cause);
  }
}

/** Whether a partially applied plan was successfully unwound. */
export type FixPlanRollbackStatus = "complete" | "failed" | "not-required";

/**
 * A failure raised after execution began.
 *
 * Separate from {@link FixPlanError} because the question a caller has at this point is not "what
 * went wrong" but "what is on disk now".
 */
export class FixPlanApplyError extends FixPlanError {
  /** Operations still applied once rollback finished. Zero unless `rollback` is `failed`. */
  readonly appliedOperationCount: number;
  /** Whether the operations applied before the failure were unwound. */
  readonly rollback: FixPlanRollbackStatus;
  /** One message per operation that could not be unwound, in the order rollback attempted them. */
  readonly rollbackFailures: readonly string[];

  constructor(
    failure: FixPlanError,
    rollback: FixPlanRollbackStatus,
    appliedOperationCount: number,
    rollbackFailures: readonly string[],
  ) {
    super(
      failure.code,
      `${failure.message} (${rollbackSummary(rollback, appliedOperationCount)})`,
      {
        cause: failure,
        operationIndex: failure.operationIndex,
        path: failure.path,
      },
    );
    this.name = "FixPlanApplyError";
    this.appliedOperationCount = appliedOperationCount;
    this.rollback = rollback;
    this.rollbackFailures = Object.freeze([...rollbackFailures]);
  }
}

/** A durable backup or undo failure with the same rollback contract as application failures. */
export class FixPlanUndoError extends FixPlanError {
  readonly rollback: FixPlanRollbackStatus;
  readonly rollbackFailures: readonly string[];

  constructor(
    failure: FixPlanError,
    rollback: FixPlanRollbackStatus = "not-required",
    rollbackFailures: readonly string[] = [],
  ) {
    super(failure.code, failure.message, {
      cause: failure,
      operationIndex: failure.operationIndex,
      path: failure.path,
    });
    this.name = "FixPlanUndoError";
    this.rollback = rollback;
    this.rollbackFailures = Object.freeze([...rollbackFailures]);
  }
}

/** Builds an error attributed to one operation, with the operation named in the message. */
export function operationError(
  code: FixPlanErrorCode,
  operationIndex: number,
  message: string,
  details: Omit<FixPlanErrorDetails, "operationIndex"> = {},
): FixPlanError {
  return new FixPlanError(code, `Fix operation ${operationIndex}: ${message}`, {
    ...details,
    operationIndex,
  });
}

function rollbackSummary(rollback: FixPlanRollbackStatus, appliedOperationCount: number): string {
  switch (rollback) {
    case "complete": {
      return "earlier operations were rolled back";
    }
    case "failed": {
      return `rollback failed; ${appliedOperationCount} operation(s) remain applied`;
    }
    case "not-required": {
      return "nothing had been applied";
    }
  }
}

/** The `errno` code of a Node filesystem failure, when the value is one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
