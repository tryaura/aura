import type { Buffer } from "node:buffer";

import { readPayload, type JournalHandle } from "./journal-read.js";
import type { StoredOperation, StoredPathState } from "./journal-schema.js";
import { revalidateMutationPath, type PathPolicy } from "./path-policy.js";
import { matchRoot } from "./roots.js";
import { inspectPath, statesEqual, type PathState } from "./state.js";
import { FixPlanError, FixPlanUndoError, operationError } from "./types.js";

export interface SelectedOperation {
  readonly operation: StoredOperation;
  readonly shouldRestore: boolean;
}

/**
 * Decides what the entry may put back, and refuses the whole undo if anything else moved.
 *
 * `policy` is built from the caller's current workspace, not from the entry. The entry is a file in
 * the home directory, so what it claims about where it may write is not evidence: a restore is
 * authorized by the roots the caller can grant right now, narrowed by the roots the plan recorded.
 */
export async function preflightUndo(
  entry: JournalHandle,
  policy: PathPolicy,
): Promise<readonly SelectedOperation[]> {
  const pending = entry.manifest.status === "pending";
  const selected: SelectedOperation[] = [];
  for (const operation of entry.manifest.operations) {
    const after = await matchesAfter(entry, operation);
    // Only a pending entry can have operations that never reached the disk, and only then is the
    // previous state worth the reads it takes to compare.
    if (!after && !(pending && (await matchesBefore(entry, operation)))) {
      throw conflict(operation.index, primaryPath(operation));
    }
    selected.push({ operation, shouldRestore: after });
  }

  for (const { operation, shouldRestore } of selected) {
    if (!shouldRestore) {
      continue;
    }
    for (const path of mutationPaths(operation)) {
      await revalidateMutationPath(path, policy, operation.index);
      assertRecordedRoot(path, entry, operation.index);
    }
  }
  return Object.freeze(selected);
}

export function primaryPath(operation: StoredOperation): string {
  return operation.type === "move" ? operation.sourcePath : operation.path;
}

/** Narrows an authorized path to one the plan being undone was itself allowed to write. */
function assertRecordedRoot(path: string, entry: JournalHandle, operationIndex: number): void {
  const { caseInsensitive, roots } = entry.manifest;
  if (matchRoot(path, roots, caseInsensitive) === undefined) {
    throw operationError(
      "undo-conflict",
      operationIndex,
      `path is outside the roots the plan recorded: ${path}`,
      { path },
    );
  }
}

async function matchesBefore(entry: JournalHandle, operation: StoredOperation): Promise<boolean> {
  switch (operation.type) {
    case "move": {
      return (
        (await matches(entry, operation.sourcePath, operation.sourceBefore)) &&
        (await matches(entry, operation.destinationPath, { kind: "missing" }))
      );
    }
    case "remove":
    case "symlink":
    case "write": {
      return matches(entry, operation.path, operation.before);
    }
  }
}

async function matchesAfter(entry: JournalHandle, operation: StoredOperation): Promise<boolean> {
  switch (operation.type) {
    case "move": {
      return (
        (await matches(entry, operation.sourcePath, { kind: "missing" })) &&
        (await matches(entry, operation.destinationPath, operation.sourceBefore))
      );
    }
    case "remove": {
      return matches(entry, operation.path, { kind: "missing" });
    }
    case "symlink": {
      return matches(entry, operation.path, { kind: "symlink", target: operation.target });
    }
    case "write": {
      return matches(entry, operation.path, operation.after);
    }
  }
}

async function matches(
  entry: JournalHandle,
  path: string,
  expected: StoredPathState,
): Promise<boolean> {
  const content =
    expected.kind === "file" && expected.payload !== undefined
      ? await readPayload(entry.directory, expected)
      : undefined;
  const current = await inspectPath(path, 0, content?.byteLength ?? 0);
  return statesEqual(toPathState(expected, content), current);
}

function toPathState(expected: StoredPathState, content: Buffer | undefined): PathState {
  return expected.kind === "file" ? { ...expected, content } : expected;
}

function mutationPaths(operation: StoredOperation): readonly string[] {
  return operation.type === "move"
    ? [operation.sourcePath, operation.destinationPath]
    : [operation.path];
}

function conflict(index: number, path: string): FixPlanUndoError {
  return new FixPlanUndoError(
    new FixPlanError(
      "undo-conflict",
      `path changed after fix operation ${String(index)}: ${path}`,
      {
        operationIndex: index,
        path,
      },
    ),
  );
}
