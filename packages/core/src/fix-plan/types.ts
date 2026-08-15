import type { FileOperation, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";

/** The filesystem effect represented by one operation preview. */
export type FixOperationEffect = "create" | "move" | "noop" | "remove" | "symlink" | "update";

/** A rendered, structured preview of one operation in a fix plan. */
export interface FixOperationPreview {
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
  /** Operations that would change the filesystem. */
  readonly changedOperationCount: number;
  /** Steps that remain for the user after automated operations finish. */
  readonly manualSteps: readonly string[];
  /** One preview per source operation, including no-ops. */
  readonly operations: readonly FixOperationPreview[];
  /** The plugin-authored plan summary. */
  readonly summary: string;
}

/** Inputs required to render a fix plan. */
export interface FixPlanPreviewOptions {
  readonly model: WorkspaceModel;
  readonly plan: FixPlan;
}

/** Inputs required to execute or dry-run a fix plan. */
export interface FixPlanExecutionOptions extends FixPlanPreviewOptions {
  /** When true, perform validation and preview reads without mutating the filesystem. */
  readonly dryRun?: boolean | undefined;
}

/** The outcome of executing or dry-running a plan. */
export interface FixPlanExecutionResult {
  /** Operations actually applied. Always zero for a dry run. */
  readonly appliedOperationCount: number;
  /** Whether filesystem mutation was disabled. */
  readonly dryRun: boolean;
  /** The preview produced immediately before execution. */
  readonly preview: FixPlanPreview;
}

/** Stable categories callers can use when presenting a rejected fix plan. */
export type FixPlanErrorCode =
  | "filesystem-changed"
  | "filesystem-error"
  | "invalid-path"
  | "path-conflict"
  | "unsupported-path";

/** A validation or execution failure tied to a particular plan operation. */
export class FixPlanError extends Error {
  readonly code: FixPlanErrorCode;
  readonly operationIndex: number;
  readonly path?: string | undefined;

  constructor(
    code: FixPlanErrorCode,
    message: string,
    operationIndex: number,
    path?: string | undefined,
  ) {
    super(`Fix operation ${operationIndex}: ${message}`);
    this.name = "FixPlanError";
    this.code = code;
    this.operationIndex = operationIndex;
    this.path = path;
  }
}
