export const JOURNAL_VERSION = 1;

export type JournalStatus = "aborted" | "applied" | "pending" | "undone";

export interface StoredMissingState {
  readonly kind: "missing";
}

export interface StoredFileState {
  readonly kind: "file";
  readonly mode: number;
  readonly modifiedTimeMs: number;
  readonly payload?: string | undefined;
  readonly size: number;
}

export interface StoredDirectoryState {
  readonly empty: boolean;
  readonly kind: "directory";
  readonly mode: number;
  readonly modifiedTimeMs: number;
}

export interface StoredSymlinkState {
  readonly kind: "symlink";
  readonly target: string;
}

export type StoredPathState =
  | StoredDirectoryState
  | StoredFileState
  | StoredMissingState
  | StoredSymlinkState;

interface StoredOperationBase {
  readonly createdDirectory?: string | undefined;
  readonly index: number;
}

export interface StoredWriteOperation extends StoredOperationBase {
  readonly after: StoredFileState;
  readonly before: StoredFileState | StoredMissingState | StoredSymlinkState;
  readonly path: string;
  readonly type: "write";
}

export interface StoredRemoveOperation extends StoredOperationBase {
  readonly before: StoredDirectoryState | StoredFileState | StoredSymlinkState;
  readonly path: string;
  readonly type: "remove";
}

export interface StoredSymlinkOperation extends StoredOperationBase {
  readonly before: StoredFileState | StoredMissingState | StoredSymlinkState;
  readonly path: string;
  readonly target: string;
  readonly type: "symlink";
}

export interface StoredMoveOperation extends StoredOperationBase {
  readonly destinationPath: string;
  readonly sourceBefore: StoredDirectoryState | StoredFileState;
  readonly sourcePath: string;
  readonly type: "move";
}

export interface StoredArchiveOperation extends StoredOperationBase {
  /** State left at the source path after archival. */
  readonly after: StoredFileState | StoredMissingState | StoredSymlinkState;
  /** Original bytes, stored below `consolidation/`. */
  readonly before: StoredFileState;
  readonly path: string;
  readonly type: "archive";
}

export type StoredOperation =
  | StoredArchiveOperation
  | StoredMoveOperation
  | StoredRemoveOperation
  | StoredSymlinkOperation
  | StoredWriteOperation;

export interface JournalManifest {
  /**
   * Whether {@link JournalManifest.roots} may be matched against a path that differs only by case.
   *
   * Holds `PathPolicy.rootsCaseInsensitive`, the narrowing answer, because its only reader is the
   * undo preflight's root check — which grants a restore rather than refusing one.
   */
  readonly caseInsensitive: boolean;
  readonly createdAt: string;
  readonly homeDir: string;
  readonly id: string;
  readonly operations: readonly StoredOperation[];
  readonly roots: readonly { readonly exact: boolean; readonly path: string }[];
  readonly status: JournalStatus;
  readonly undoneAt?: string | undefined;
  readonly version: typeof JOURNAL_VERSION;
}
