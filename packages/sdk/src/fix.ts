export interface WriteFileOperation {
  readonly content: string;
  readonly mode?: number;
  readonly path: string;
  readonly type: "write";
}

export interface RemovePathOperation {
  readonly path: string;
  readonly type: "remove";
}

export interface MovePathOperation {
  readonly destinationPath: string;
  readonly sourcePath: string;
  readonly type: "move";
}

export interface SymlinkOperation {
  readonly path: string;
  readonly target: string;
  readonly type: "symlink";
}

export type FileOperation =
  | MovePathOperation
  | RemovePathOperation
  | SymlinkOperation
  | WriteFileOperation;

export interface FixPlan {
  readonly manualSteps?: readonly string[];
  readonly operations: readonly FileOperation[];
  readonly summary: string;
}
