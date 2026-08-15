import { chmod, mkdir, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

import { removeCreatedDirectories, replaceFile, replaceLink } from "./filesystem.js";
import { listJournal, readPayload, setJournalStatus, type JournalHandle } from "./journal.js";
import type {
  StoredOperation,
  StoredPathState,
  StoredSymlinkOperation,
  StoredWriteOperation,
} from "./journal-schema.js";
import { preflightUndo, primaryPath, type SelectedOperation } from "./undo-preflight.js";
import {
  errorMessage,
  FixPlanError,
  FixPlanUndoError,
  type FixPlanRollbackStatus,
  type FixPlanUndoOptions,
  type FixPlanUndoResult,
} from "./types.js";

type UndoAction = () => Promise<void>;

interface AppliedUndo {
  readonly cleanup?: UndoAction | undefined;
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
    const selected = await preflightUndo(entry, options.homeDir);
    const restored = await restoreOperations(entry, selected);
    try {
      await setJournalStatus(entry, "undone", options.now().toISOString());
    } catch (error) {
      const rollback = await rollForward(restored);
      const failure = new FixPlanError(
        "backup-error",
        `could not finalize undo journal: ${errorMessage(error)}`,
        { cause: error },
      );
      throw new FixPlanUndoError(failure, rollback.status, rollback.failures);
    }
    return Object.freeze({
      backupId: entry.manifest.id,
      restoredOperationCount: restored.length,
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

async function restoreOperations(
  entry: JournalHandle,
  selected: readonly SelectedOperation[],
): Promise<readonly AppliedUndo[]> {
  const applied: AppliedUndo[] = [];
  for (let position = selected.length - 1; position >= 0; position -= 1) {
    const item = selected[position];
    if (item === undefined || !item.shouldRestore) {
      continue;
    }
    try {
      const step = await restoreOperation(entry, item.operation);
      applied.push(step);
      if (step.cleanup !== undefined) {
        await step.cleanup();
      }
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
  return Object.freeze(applied);
}

async function restoreOperation(
  entry: JournalHandle,
  operation: StoredOperation,
): Promise<AppliedUndo> {
  switch (operation.type) {
    case "move": {
      await rename(operation.destinationPath, operation.sourcePath);
      return {
        cleanup: cleanupAction(operation.createdDirectory, dirname(operation.destinationPath)),
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
      return restoreReplacement(entry, operation, async () =>
        replaceLink(operation.path, operation.target),
      );
    }
    case "write": {
      return restoreReplacement(entry, operation, async () => {
        const content = await readPayload(entry.directory, operation.after);
        await replaceFile(operation.path, content, operation.after.mode);
      });
    }
  }
}

async function restoreReplacement(
  entry: JournalHandle,
  operation: StoredSymlinkOperation | StoredWriteOperation,
  applyAfter: UndoAction,
): Promise<AppliedUndo> {
  await restoreState(entry, operation.path, operation.before);
  return {
    cleanup: cleanupAction(operation.createdDirectory, dirname(operation.path)),
    index: operation.index,
    redo: async () => {
      await mkdir(dirname(operation.path), { recursive: true });
      await applyAfter();
    },
  };
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

function cleanupAction(created: string | undefined, deepest: string): UndoAction | undefined {
  return created === undefined ? undefined : async () => removeCreatedDirectories(created, deepest);
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
  return {
    failures: Object.freeze([]),
    status: applied.length === 0 ? "not-required" : "complete",
  };
}
