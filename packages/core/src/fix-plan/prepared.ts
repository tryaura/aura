import type {
  ArchiveFileOperation,
  MovePathOperation,
  RemovePathOperation,
  SymlinkOperation,
  WorkspaceModel,
  WriteFileOperation,
} from "@tryaura/aura-sdk";

import { renderConflict } from "./diff.js";
import type { PathPolicy, ValidatedOperation } from "./path-policy.js";
import type {
  CapturedFileState,
  DirectoryPathState,
  FilePathState,
  MissingPathState,
  SymlinkPathState,
} from "./state.js";
import { operationError, type FixOperationEffect, type FixOperationPreview } from "./types.js";
import type { FixPlanError, FixPlanPreview } from "./types.js";

interface PreparedBase {
  readonly preview: FixOperationPreview;
}

export interface PreparedArchiveOperation extends PreparedBase {
  readonly before: CapturedFileState;
  readonly operation: ArchiveFileOperation;
  readonly replacementMode?: number | undefined;
  readonly type: "archive";
}

/** An operation the current filesystem state does not permit. Reported, never applied. */
export interface PreparedConflictOperation extends PreparedBase {
  readonly type: "conflict";
}

/** An operation the filesystem already satisfies. */
export interface PreparedNoopOperation extends PreparedBase {
  readonly type: "noop";
}

export interface PreparedWriteOperation extends PreparedBase {
  readonly before: CapturedFileState | MissingPathState | SymlinkPathState;
  /**
   * The mode the file will actually have, decided while the preview was rendered.
   *
   * Not always {@link WriteFileOperation.mode}: an existing file keeps what it has, and core holds
   * its own protocol files at a fixed mode. Resolving it once is what keeps the preview, the
   * journal, and the write from each deriving it and drifting apart.
   */
  readonly mode: number;
  readonly operation: WriteFileOperation;
  readonly type: "write";
}

export interface PreparedRemoveOperation extends PreparedBase {
  readonly before: CapturedFileState | DirectoryPathState | SymlinkPathState;
  readonly operation: RemovePathOperation;
  readonly type: "remove";
}

export interface PreparedMoveOperation extends PreparedBase {
  readonly destinationBefore: MissingPathState;
  readonly operation: MovePathOperation;
  readonly sourceBefore: DirectoryPathState | FilePathState;
  readonly type: "move";
}

export interface PreparedSymlinkOperation extends PreparedBase {
  readonly before: CapturedFileState | MissingPathState | SymlinkPathState;
  readonly operation: SymlinkOperation;
  readonly type: "symlink";
}

export type PreparedOperation =
  | PreparedArchiveOperation
  | PreparedConflictOperation
  | PreparedMoveOperation
  | PreparedNoopOperation
  | PreparedRemoveOperation
  | PreparedSymlinkOperation
  | PreparedWriteOperation;

/**
 * Operations the executor can actually apply.
 *
 * Each carries exactly the previous state its rollback needs and nothing wider, so the executor has
 * no impossible branches to defend against.
 */
export type ApplicableOperation =
  | PreparedArchiveOperation
  | PreparedMoveOperation
  | PreparedRemoveOperation
  | PreparedSymlinkOperation
  | PreparedWriteOperation;

export interface PreparedPlanState {
  readonly model: WorkspaceModel;
  readonly operations: readonly PreparedOperation[];
  readonly policy: PathPolicy;
}

export function isApplicable(operation: PreparedOperation): operation is ApplicableOperation {
  return operation.type !== "conflict" && operation.type !== "noop";
}

export function createPreview(
  operation: ValidatedOperation,
  effect: FixOperationEffect,
  diff: string,
): FixOperationPreview {
  return Object.freeze({
    diff,
    effect,
    index: operation.index,
    operation: operation.operation,
    paths: operation.paths,
  });
}

export function noop(operation: ValidatedOperation): PreparedNoopOperation {
  return { preview: createPreview(operation, "noop", ""), type: "noop" };
}

export function conflict(operation: ValidatedOperation, reason: string): PreparedConflictOperation {
  return {
    preview: Object.freeze({
      conflict: reason,
      diff: renderConflict(operation.operation.type, operation.paths[0] ?? "", reason),
      effect: "conflict",
      index: operation.index,
      operation: operation.operation,
      paths: operation.paths,
    }),
    type: "conflict",
  };
}

/** Raised when a caller asks to apply a plan whose preview already reported it as blocked. */
export function blockedPlanError(preview: FixPlanPreview): FixPlanError {
  const first = preview.operations.find((operation) => operation.effect === "conflict");
  return operationError(
    "plan-blocked",
    first?.index ?? 0,
    `plan has ${preview.conflictedOperationCount} blocked operation(s) and cannot be applied: ${first?.conflict ?? "unknown conflict"}`,
    { path: first?.paths[0] },
  );
}
