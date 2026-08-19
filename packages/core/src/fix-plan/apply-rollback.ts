import { errorMessage } from "../values.js";

type UndoAction = () => Promise<void>;

/** One registered operation whose partial or complete effects can be unwound. */
export interface UndoStep {
  /** Created parent directories, removed best-effort after `undo` succeeds. Never load-bearing. */
  readonly cleanup?: UndoAction | undefined;
  /**
   * Whether anything this step would have to unwind has actually reached the disk yet.
   *
   * Read at rollback time, not at registration time, so it must be a live view of the mutation's
   * progress rather than a captured value — see {@link RegisterUndo} for why that matters.
   */
  readonly hasEffects: () => boolean;
  readonly index: number;
  readonly undo: UndoAction;
}

export interface RollbackOutcome {
  readonly failures: readonly string[];
  /** Operations still applied once rollback stopped. */
  readonly remaining: number;
}

export function appliedEffectCount(applied: readonly UndoStep[]): number {
  return applied.filter((step) => step.hasEffects()).length;
}

/** Unwinds substantive effects in reverse, then cleans created parent directories best-effort. */
export async function rollbackAppliedSteps(applied: readonly UndoStep[]): Promise<RollbackOutcome> {
  for (let position = applied.length - 1; position >= 0; position -= 1) {
    const step = applied[position];
    if (step === undefined || !step.hasEffects()) {
      continue;
    }

    try {
      await step.undo();
    } catch (error) {
      return {
        failures: Object.freeze([`operation ${String(step.index)}: ${errorMessage(error)}`]),
        remaining: appliedEffectCount(applied.slice(0, position + 1)),
      };
    }
    if (step.cleanup !== undefined) {
      await step.cleanup().catch(() => undefined);
    }
  }

  return { failures: Object.freeze([]), remaining: 0 };
}
