import type { UndoStep } from "./apply-rollback.js";
import { removeCreatedDirectories, replaceFile, type MutationFileSystem } from "./filesystem.js";
import { revalidateMutationPath } from "./path-policy.js";
import type { PreparedPlanState } from "./prepared.js";
import { inspectPath, statesEqual, type CapturedFileState, type PathState } from "./state.js";
import { operationError } from "./types.js";

/**
 * Hands the executor the step that unwinds an operation.
 *
 * Two rules the type cannot enforce, and both are load-bearing:
 *
 * 1. Register **before** performing the mutation. A step registered afterwards is never reached if
 *    the mutation itself throws, and its effects are then unrecoverable.
 * 2. Report {@link UndoStep.hasEffects} as true only **after** the mutation has landed. The
 *    executor unwinds every step that claims effects and skips every step that does not, so a step
 *    that claims them early makes rollback undo work that never happened.
 *
 * Together they mean a half-applied operation is always unwindable: the step exists from before the
 * first write, and it starts describing effects the instant there are any. `apply-faults.test.ts`
 * is the executable form of this contract — a new operation type belongs in those cases.
 */
export type RegisterUndo = (step: UndoStep) => void;

export interface CreatedParents {
  created?: string | undefined;
  readonly deepest: string;
}

/** Puts a captured file back exactly as it was read, timestamp included. */
export async function restoreFile(
  path: string,
  state: CapturedFileState,
  filesystem: MutationFileSystem,
): Promise<void> {
  await replaceFile(path, state.content, state.mode, filesystem);
  await filesystem.utimes(path, state.modifiedTimeMs / 1000, state.modifiedTimeMs / 1000);
}

export function createdParents(deepest: string): CreatedParents {
  return { deepest };
}

export async function ensureDirectory(
  parents: CreatedParents,
  filesystem: MutationFileSystem,
): Promise<void> {
  parents.created = await filesystem.mkdir(parents.deepest, { recursive: true });
}

export function cleanupParents(
  parents: CreatedParents,
  filesystem: MutationFileSystem,
): () => Promise<void> {
  return async () => {
    if (parents.created !== undefined) {
      await removeCreatedDirectories(parents.created, parents.deepest, filesystem);
      parents.created = undefined;
    }
  };
}

export async function verifyPath(
  path: string,
  expected: PathState,
  operationIndex: number,
  plan: PreparedPlanState,
): Promise<void> {
  await revalidateMutationPath(path, plan.policy, operationIndex);

  const current = await inspectPath(path, operationIndex, contentBudgetFor(expected));
  if (!statesEqual(expected, current)) {
    throw operationError(
      "filesystem-changed",
      operationIndex,
      `path changed after its preview was prepared: ${path}`,
      { path },
    );
  }
}

/** Re-reads contents only when the captured state has contents to compare against. */
function contentBudgetFor(expected: PathState): number {
  return expected.kind === "file" && expected.content !== undefined
    ? expected.content.byteLength
    : 0;
}
