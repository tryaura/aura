import { chmod, mkdir, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

import { removeCreatedDirectories, replaceFile, replaceLink } from "./filesystem.js";
import { backupRoot, listJournal, readPayload, setJournalStatus, type JournalHandle } from "./journal.js";
import type { StoredOperation, StoredPathState } from "./journal-schema.js";
import { revalidateMutationPath, type PathPolicy } from "./path-policy.js";
import { inspectPath, statesEqual, type PathState } from "./state.js";
import {
  errorMessage,
  FixPlanError,
  FixPlanUndoError,
  type FixPlanRollbackStatus,
  type FixPlanUndoOptions,
  type FixPlanUndoResult,
} from "./types.js";

type UndoAction = () => Promise<void>;

interface SelectedOperation {
  readonly operation: StoredOperation;
  readonly shouldRestore: boolean;
}

interface AppliedUndo {
  readonly index: number;
  readonly redo: UndoAction;
}

export async function undoLastFixPlan(options: FixPlanUndoOptions): Promise<FixPlanUndoResult> {
  const entries = await listJournal(options.homeDir);
  const entry = entries.find(
    ({ manifest }) => manifest.status === "applied" || manifest.status === "pending",
  );
  if (entry === undefined) {
    return Object.freeze({ status: "nothing-to-undo" });
  }

  try {
    const selected = await preflight(entry, options.homeDir);
    const restored = await restoreOperations(entry, selected);
    await setJournalStatus(entry, "undone", options.now().toISOString());
    return Object.freeze({
      backupId: entry.manifest.id,
      restoredOperationCount: restored,
      status: "undone",
    });
  } catch (error) {
    if (error instanceof FixPlanUndoError) {
      throw error;
    }
    const failure =
      error instanceof FixPlanError
        ? error
        : new FixPlanError("filesystem-error", `could not undo fix plan: ${errorMessage(error)}`, {
            cause: error,
          });
    throw new FixPlanUndoError(failure);
  }
}

async function preflight(
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

async function restoreOperations(
  entry: JournalHandle,
  selected: readonly SelectedOperation[],
): Promise<number> {
  const applied: AppliedUndo[] = [];
  for (let position = selected.length - 1; position >= 0; position -= 1) {
    const item = selected[position];
    if (item === undefined || !item.shouldRestore) {
      continue;
    }
    try {
      applied.push(await restoreOperation(entry, item.operation));
    } catch (error) {
      const rollback = await rollForward(applied);
      const failure = new FixPlanError(
        "filesystem-error",
        `could not restore operation ${String(item.operation.index)}: ${errorMessage(error)}`,
        { cause: error, operationIndex: item.operation.index, path: primaryPath(item.operation) },
      );
      throw new FixPlanUndoError(failure, rollback.status, rollback.failures);
    }
  }
  return applied.length;
}

async function restoreOperation(
  entry: JournalHandle,
  operation: StoredOperation,
): Promise<AppliedUndo> {
  switch (operation.type) {
    case "move": {
      await rename(operation.destinationPath, operation.sourcePath);
      await cleanup(operation.createdDirectory, dirname(operation.destinationPath));
      return {
        index: operation.index,
        redo: async () => {
          await mkdir(dirname(operation.destinationPath), { recursive: true });
          await rename(operation.sourcePath, operation.destinationPath);
        },
      };
    }
    case "remove": {
      await restoreState(entry, operation.path, operation.before);
      return {
        index: operation.index,
        redo: async () => removeState(operation.path, operation.before),
      };
    }
    case "symlink": {
      await restoreState(entry, operation.path, operation.before);
      await cleanup(operation.createdDirectory, dirname(operation.path));
      return {
        index: operation.index,
        redo: async () => {
          await mkdir(dirname(operation.path), { recursive: true });
          await replaceLink(operation.path, operation.target);
        },
      };
    }
    case "write": {
      await restoreState(entry, operation.path, operation.before);
      await cleanup(operation.createdDirectory, dirname(operation.path));
      return {
        index: operation.index,
        redo: async () => {
          await mkdir(dirname(operation.path), { recursive: true });
          const content = await readPayload(entry.directory, operation.after);
          await replaceFile(operation.path, content, operation.after.mode);
        },
      };
    }
  }
}

async function restoreState(
  entry: JournalHandle,
  path: string,
  state: StoredPathState,
): Promise<void> {
  switch (state.kind) {
    case "missing": {
      await rm(path, { force: true });
      return;
    }
    case "file": {
      const content = await readPayload(entry.directory, state);
      await replaceFile(path, content, state.mode);
      await utimes(path, state.modifiedTimeMs / 1000, state.modifiedTimeMs / 1000);
      return;
    }
    case "directory": {
      await mkdir(path);
      await chmod(path, state.mode);
      await utimes(path, state.modifiedTimeMs / 1000, state.modifiedTimeMs / 1000);
      return;
    }
    case "symlink": {
      await replaceLink(path, state.target);
    }
  }
}

async function removeState(path: string, state: StoredPathState): Promise<void> {
  if (state.kind === "directory") {
    await rmdir(path);
  } else {
    await unlink(path);
  }
}

async function cleanup(created: string | undefined, deepest: string): Promise<void> {
  if (created !== undefined) {
    await removeCreatedDirectories(created, deepest);
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
  const content = expected.kind === "file" && expected.payload !== undefined
    ? await readPayload(entry.directory, expected)
    : undefined;
  const current = await inspectPath(path, 0, content?.byteLength ?? 0);
  return statesEqual(toPathState(expected, content), current);
}

function toPathState(expected: StoredPathState, content: Buffer | undefined): PathState {
  return expected.kind === "file" ? { ...expected, content } : expected;
}

async function rollForward(
  applied: readonly AppliedUndo[],
): Promise<{ readonly failures: readonly string[]; readonly status: FixPlanRollbackStatus }> {
  for (let position = applied.length - 1; position >= 0; position -= 1) {
    const step = applied[position];
    if (step === undefined) {
      continue;
    }
    try {
      await step.redo();
    } catch (error) {
      return {
        failures: Object.freeze([`operation ${String(step.index)}: ${errorMessage(error)}`]),
        status: "failed",
      };
    }
  }
  return { failures: Object.freeze([]), status: applied.length === 0 ? "not-required" : "complete" };
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

function primaryPath(operation: StoredOperation): string {
  return operation.type === "move" ? operation.sourcePath : operation.path;
}

function conflict(index: number, path: string): FixPlanUndoError {
  return new FixPlanUndoError(
    new FixPlanError("undo-conflict", `path changed after fix operation ${String(index)}: ${path}`, {
      operationIndex: index,
      path,
    }),
  );
}
