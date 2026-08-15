import type { Buffer } from "node:buffer";

import { backupRoot, readPayload, type JournalHandle } from "./journal.js";
import type { StoredOperation, StoredPathState } from "./journal-schema.js";
import { revalidateMutationPath, type PathPolicy } from "./path-policy.js";
import { inspectPath, statesEqual, type PathState } from "./state.js";
import { FixPlanError, FixPlanUndoError } from "./types.js";

export interface SelectedOperation {
  readonly operation: StoredOperation;
  readonly shouldRestore: boolean;
}

export async function preflightUndo(
  entry: JournalHandle,
  homeDir: string,
): Promise<readonly SelectedOperation[]> {
  const selected: SelectedOperation[] = [];
  for (const operation of entry.manifest.operations) {
    const before = await matchesBefore(entry, operation);
    const after = await matchesAfter(entry, operation);
    const pending = entry.manifest.status === "pending";
    if (!after && !(pending && before)) {
      throw conflict(operation.index, primaryPath(operation));
    }
    selected.push({ operation, shouldRestore: after });
  }

  const policy = policyFor(entry, homeDir);
  for (const { operation, shouldRestore } of selected) {
    if (!shouldRestore) {
      continue;
    }
    for (const path of mutationPaths(operation)) {
      await revalidateMutationPath(path, policy, operation.index);
    }
  }
  return Object.freeze(selected);
}

export function primaryPath(operation: StoredOperation): string {
  return operation.type === "move" ? operation.sourcePath : operation.path;
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

function policyFor(entry: JournalHandle, homeDir: string): PathPolicy {
  return {
    caseInsensitive: entry.manifest.caseInsensitive,
    reservedRoots: Object.freeze([backupRoot(homeDir)]),
    roots: entry.manifest.roots,
  };
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
