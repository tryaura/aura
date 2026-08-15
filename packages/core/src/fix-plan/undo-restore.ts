import { chmod, mkdir, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

import { removeCreatedDirectories, replaceFile, replaceLink } from "./filesystem.js";
import { readPayload, type JournalHandle } from "./journal-read.js";
import type {
  StoredOperation,
  StoredPathState,
  StoredSymlinkOperation,
  StoredWriteOperation,
} from "./journal-schema.js";
import { primaryPath, type SelectedOperation } from "./undo-preflight.js";
import {
  errorMessage,
  FixPlanError,
  FixPlanUndoError,
  type FixPlanRollbackStatus,
} from "./types.js";

type UndoAction = () => Promise<void>;

interface AppliedUndo {
  readonly cleanup?: UndoAction | undefined;
  readonly index: number;
  readonly redo: UndoAction;
}

/**
 * Puts every selected operation back, latest first.
 *
 * A restore that cannot finish is rolled forward rather than left half done: the filesystem returns
 * to what the plan left there, which is the one state the journal still describes accurately.
 */
export async function restoreOperations(
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

export async function rollForward(
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
      try {
        await restoreState(entry, operation.path, operation.before);
      } catch (error) {
        await removeRestoredState(operation.path, operation.before);
        throw error;
      }
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
  try {
    await restoreState(entry, operation.path, operation.before);
  } catch (error) {
    await mkdir(dirname(operation.path), { recursive: true });
    await applyAfter();
    throw error;
  }
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
      // The mode goes to `mkdir` as well as `chmod`, so a directory that was owner-only never
      // exists at the umask default, however briefly.
      await mkdir(path, { mode: state.mode });
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

async function removeRestoredState(path: string, state: StoredPathState): Promise<void> {
  if (state.kind === "directory") {
    await rmdir(path).catch(() => undefined);
  } else {
    await rm(path, { force: true });
  }
}

function cleanupAction(created: string | undefined, deepest: string): UndoAction | undefined {
  return created === undefined ? undefined : async () => removeCreatedDirectories(created, deepest);
}
