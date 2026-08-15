import { applyPreparedOperation, type UndoStep } from "./apply.js";
import { prepareOperations } from "./prepare.js";
import {
  blockedPlanError,
  isApplicable,
  type ApplicableOperation,
  type PreparedPlanState,
} from "./prepared.js";
import {
  FixPlanApplyError,
  FixPlanError,
  operationError,
  type FixPlanExecutionOptions,
  type FixPlanExecutionResult,
  type FixPlanPreview,
  type FixPlanPreviewOptions,
  type FixPlanRollbackStatus,
} from "./types.js";

/**
 * Carries the state {@link applyFixPlan} needs alongside the preview a caller shows the user.
 *
 * Not exported from the package root: a prepared plan is produced by {@link prepareFixPlan} and
 * consumed by {@link applyFixPlan}, and nothing outside those two has any business reading it.
 */
const PREPARED_STATE: unique symbol = Symbol("aura.fix-plan.prepared");

/** A validated plan, rendered but not yet applied. */
export interface PreparedFixPlan {
  readonly [PREPARED_STATE]: PreparedPlanState;
  /** What applying the plan would do. */
  readonly preview: FixPlanPreview;
}

interface RollbackOutcome {
  readonly failures: readonly string[];
  /** Operations still applied once rollback stopped. */
  readonly remaining: number;
}

/** Validates and renders a plan without mutating the filesystem. */
export async function previewFixPlan(options: FixPlanPreviewOptions): Promise<FixPlanPreview> {
  return (await prepareFixPlan(options)).preview;
}

/**
 * Validates and renders a plan, keeping the state needed to apply exactly what was rendered.
 *
 * Use this with {@link applyFixPlan} for a confirm-then-apply flow: it reads the filesystem once
 * rather than once per call, and the plan a user confirms is the plan that runs. Every path is
 * still rechecked at the moment it is mutated, so a plan cannot become stale-but-applied.
 */
export async function prepareFixPlan(options: FixPlanPreviewOptions): Promise<PreparedFixPlan> {
  const { preview, state } = await prepareOperations(options);
  return Object.freeze({ [PREPARED_STATE]: state, preview });
}

/**
 * Applies a plan prepared by {@link prepareFixPlan}.
 *
 * Refuses a plan with any blocked operation rather than applying it in part. If an operation fails
 * partway through, the operations already applied are rolled back and the failure is reported as a
 * {@link FixPlanApplyError} describing what is on disk.
 */
export async function applyFixPlan(prepared: PreparedFixPlan): Promise<FixPlanExecutionResult> {
  if (prepared.preview.conflictedOperationCount > 0) {
    throw blockedPlanError(prepared.preview);
  }

  return applyOperations(prepared[PREPARED_STATE], prepared.preview);
}

/** Validates, previews, and optionally applies a plan through the kernel's single write path. */
export async function executeFixPlan(
  options: FixPlanExecutionOptions,
): Promise<FixPlanExecutionResult> {
  const prepared = await prepareFixPlan(options);
  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    return Object.freeze({ appliedOperationCount: 0, dryRun, preview: prepared.preview });
  }

  return applyFixPlan(prepared);
}

async function applyOperations(
  plan: PreparedPlanState,
  preview: FixPlanPreview,
): Promise<FixPlanExecutionResult> {
  const applied: UndoStep[] = [];

  for (const operation of plan.operations.filter(isApplicable)) {
    try {
      applied.push(await applyPreparedOperation(operation, plan));
    } catch (error) {
      const outcome = await rollback(applied);
      throw new FixPlanApplyError(
        asFixPlanError(error, operation),
        rollbackStatus(applied.length, outcome),
        outcome.remaining,
        outcome.failures,
      );
    }
  }

  return Object.freeze({ appliedOperationCount: applied.length, dryRun: false, preview });
}

/**
 * Unwinds applied operations in reverse.
 *
 * Stops at the first step it cannot undo. Continuing past one would unwind operations whose effects
 * the failed step still depends on, turning a recoverable partial application into a worse one.
 */
async function rollback(applied: readonly UndoStep[]): Promise<RollbackOutcome> {
  for (let position = applied.length - 1; position >= 0; position -= 1) {
    const step = applied[position];
    if (step === undefined) {
      continue;
    }

    try {
      await step.undo();
    } catch (error) {
      return {
        failures: Object.freeze([`operation ${step.index}: ${messageOf(error)}`]),
        remaining: position + 1,
      };
    }
  }

  return { failures: Object.freeze([]), remaining: 0 };
}

function rollbackStatus(attempted: number, outcome: RollbackOutcome): FixPlanRollbackStatus {
  if (attempted === 0) {
    return "not-required";
  }
  return outcome.failures.length > 0 ? "failed" : "complete";
}

function asFixPlanError(error: unknown, prepared: ApplicableOperation): FixPlanError {
  if (error instanceof FixPlanError) {
    return error;
  }

  return operationError(
    "filesystem-error",
    prepared.preview.index,
    `could not apply ${prepared.type} operation: ${messageOf(error)}`,
    { cause: error, path: prepared.preview.paths[0] },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
