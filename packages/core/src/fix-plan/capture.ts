import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_MUTABLE_FILE_BYTES } from "./limits.js";
import { mutationPaths, type ValidatedOperation } from "./path-policy.js";
import {
  inspectPath,
  isCapturedFile,
  type CapturedFileState,
  type DirectoryPathState,
  type MissingPathState,
  type PathState,
  type SymlinkPathState,
} from "./state.js";

/** A path state Aura is willing to change, because it can put it back. */
export type CapturedState =
  | CapturedFileState
  | DirectoryPathState
  | MissingPathState
  | SymlinkPathState;

type CaptureFailure =
  | { readonly kind: "oversized"; readonly size: number }
  | { readonly kind: "unsupported" };

type CaptureResult = { readonly failure: CaptureFailure } | { readonly state: CapturedState };

/** How much file content the plan may still capture. */
export interface RetentionBudget {
  remaining: number;
}

/**
 * Reads a path and reports either the state to work from or the conflict that blocks it.
 *
 * `action` completes the sentence a user reads when the path cannot be captured, for example
 * "written over" or "removed".
 */
export async function captureBefore(
  validated: ValidatedOperation,
  path: string,
  budget: RetentionBudget,
  action: string,
): Promise<{ readonly conflict: string } | { readonly state: CapturedState }> {
  const captured = captureState(await inspectPath(path, validated.index, contentBudget(budget)));
  return "failure" in captured
    ? { conflict: describeFailure(captured.failure, action) }
    : { state: captured.state };
}

/**
 * Sorts a path state into one Aura can reverse and one it cannot.
 *
 * A file whose contents did not fit the budget is refused rather than changed: an operation with no
 * captured `before` is one rollback could not undo, and a preview built from contents Aura never
 * read would describe a change it cannot make.
 */
function captureState(state: PathState): CaptureResult {
  switch (state.kind) {
    case "unsupported": {
      return { failure: { kind: "unsupported" } };
    }
    case "file": {
      return isCapturedFile(state)
        ? { state }
        : { failure: { kind: "oversized", size: state.size } };
    }
    case "directory":
    case "missing":
    case "symlink": {
      return { state };
    }
  }
}

function describeFailure(failure: CaptureFailure, action: string): string {
  switch (failure.kind) {
    case "oversized": {
      return `file is ${failure.size} bytes and cannot be ${action}: Aura only changes a file whose previous contents it captured, so the change stays reversible`;
    }
    case "unsupported": {
      return "path is not a regular file, directory, or symbolic link";
    }
  }
}

/** The read ceiling for the next path, bounded by both the per-file and per-plan limits. */
function contentBudget(budget: RetentionBudget): number {
  return Math.min(MAX_MUTABLE_FILE_BYTES, budget.remaining);
}

export function spendBudget(budget: RetentionBudget, state: CapturedState): void {
  if (state.kind === "file") {
    budget.remaining -= state.content.byteLength;
  }
}

/**
 * Reports the first mutation path whose nearest existing ancestor is not writable.
 *
 * Every mutation goes through its parent directory — a replacement is written beside its target and
 * renamed into place — so parent permission decides whether an operation can run at all. Learning
 * that here makes it a preview a user can act on rather than a failure halfway through a plan.
 */
export async function findUnwritablePath(
  operation: ValidatedOperation,
): Promise<string | undefined> {
  for (const path of mutationPaths(operation.operation)) {
    const directory = await nearestExistingAncestor(dirname(path));
    if (directory === undefined) {
      continue;
    }

    try {
      await access(directory, constants.W_OK | constants.X_OK);
    } catch {
      return `no write permission for ${directory}`;
    }
  }

  return undefined;
}

async function nearestExistingAncestor(directory: string): Promise<string | undefined> {
  let current = directory;

  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}
