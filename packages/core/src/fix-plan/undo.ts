import { pluralize } from "../pluralize.js";
import { withJournalLock } from "./journal-lock.js";
import { readJournal, type JournalEntry, type JournalHandle } from "./journal-read.js";
import type { JournalStatus, StoredOperation } from "./journal-schema.js";
import { ensureBackupRoot, openBackupRoot, setJournalStatus } from "./journal.js";
import { createPathPolicy, type PathPolicy } from "./path-policy.js";
import { targetPaths, withTargetLocks } from "./target-lock.js";
import { preflightUndo } from "./undo-preflight.js";
import { restoreOperations, rollForward } from "./undo-restore.js";
import { errorMessage } from "../values.js";
import {
  FixPlanError,
  FixPlanUndoError,
  type FixPlanBackup,
  type FixPlanBackupListOptions,
  type FixPlanUndoOptions,
  type FixPlanUndoResult,
} from "./types.js";

interface Selection {
  readonly entry: JournalHandle;
  /** Entries newer than the selected one that could not be read. */
  readonly skipped: readonly string[];
}

/**
 * Everything the store holds, newest first.
 *
 * Reports entries it could not read rather than omitting them, so a caller offering an undo can say
 * why an entry is missing from the list instead of quietly showing a shorter one.
 */
export async function listFixPlanBackups(
  options: FixPlanBackupListOptions,
): Promise<readonly FixPlanBackup[]> {
  const root = await openBackupRoot(options.homeDir);
  if (root === undefined) {
    return Object.freeze([]);
  }

  const backups: FixPlanBackup[] = [];
  for await (const entry of readJournal(root, options.homeDir)) {
    backups.push(describe(entry));
  }
  return Object.freeze(backups);
}

/**
 * Puts back what a fix plan changed.
 *
 * Undoes the most recent entry that is still on disk, or the one named by
 * {@link FixPlanUndoOptions.backupId}. The whole entry is restored or none of it is: if any path it
 * touched has changed since, the undo is refused before anything is written.
 */
export async function undoFixPlan(options: FixPlanUndoOptions): Promise<FixPlanUndoResult> {
  const root = await openBackupRoot(options.model.homeDir);
  if (root === undefined) {
    return Object.freeze({ status: "nothing-to-undo" });
  }

  const policy = await createPathPolicy(options.model, options.managedHomeRoots);
  return withJournalLock(root, options.now, async () => {
    const selection = await select(root, options);
    if (selection === undefined) {
      return Object.freeze({ status: "nothing-to-undo" });
    }
    const targets = targetPaths(
      selection.entry.manifest.operations.flatMap(storedOperationPaths),
      policy.caseInsensitive,
    );
    const targetRoot = await ensureBackupRoot(options.stateHomeDir ?? options.model.homeDir);
    return withTargetLocks(targets, targetRoot, options.now, async () =>
      restore(selection, policy, options.now),
    );
  });
}

function storedOperationPaths(operation: StoredOperation): readonly string[] {
  switch (operation.type) {
    case "move": {
      return [operation.sourcePath, operation.destinationPath];
    }
    case "archive":
    case "remove":
    case "symlink":
    case "write": {
      return [operation.path];
    }
  }
}

async function restore(
  selection: Selection,
  policy: PathPolicy,
  now: () => Date,
): Promise<FixPlanUndoResult> {
  const { entry, skipped } = selection;
  try {
    const selected = await preflightUndo(entry, policy);
    const restored = await restoreOperations(entry, selected);
    try {
      await setJournalStatus(entry, "undone", now().toISOString());
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
      skippedBackupIds: skipped,
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

async function select(root: string, options: FixPlanUndoOptions): Promise<Selection | undefined> {
  const { backupId, model } = options;
  return backupId === undefined
    ? selectLatest(root, model.homeDir)
    : selectNamed(root, model.homeDir, backupId);
}

/**
 * The most recent entry still on disk, stepping over entries that cannot be read.
 *
 * Stepping over one is safe because every restore is gated on the paths still holding what its entry
 * left there: if an unreadable entry did change those paths, the older entry is refused rather than
 * applied over it. Doing so silently would not be safe, so what was stepped over is carried out.
 */
async function selectLatest(root: string, homeDir: string): Promise<Selection | undefined> {
  const skipped: string[] = [];
  for await (const entry of readJournal(root, homeDir)) {
    if (entry.kind === "unreadable") {
      skipped.push(entry.id);
      continue;
    }
    if (isUndoable(entry.handle.manifest.status)) {
      return { entry: entry.handle, skipped: Object.freeze(skipped) };
    }
  }

  if (skipped.length > 0) {
    throw new FixPlanError(
      "journal-corrupt",
      `no undoable backup remains; ${String(skipped.length)} unreadable ${pluralize(skipped.length, "entry", "entries")}: ${skipped.join(", ")}`,
    );
  }
  return undefined;
}

async function selectNamed(root: string, homeDir: string, backupId: string): Promise<Selection> {
  for await (const entry of readJournal(root, homeDir)) {
    if (entry.id !== backupId) {
      continue;
    }
    if (entry.kind === "unreadable") {
      throw new FixPlanError("journal-corrupt", `backup ${entry.id} is ${entry.reason}`);
    }
    const { status } = entry.handle.manifest;
    if (!isUndoable(status)) {
      throw new FixPlanError(
        "backup-error",
        `backup ${entry.id} is already ${status} and cannot be undone`,
      );
    }
    return { entry: entry.handle, skipped: Object.freeze([]) };
  }

  throw new FixPlanError("backup-error", `no undo journal entry named ${backupId}`);
}

/** Whether an entry describes work that is still on disk. */
function isUndoable(status: JournalStatus): boolean {
  return status === "applied" || status === "pending";
}

function describe(entry: JournalEntry): FixPlanBackup {
  if (entry.kind === "unreadable") {
    return Object.freeze({
      id: entry.id,
      reason: entry.reason,
      status: "unreadable",
      undoable: false,
    });
  }
  const { manifest } = entry.handle;
  return Object.freeze({
    createdAt: manifest.createdAt,
    id: manifest.id,
    operationCount: manifest.operations.length,
    status: manifest.status,
    undoable: isUndoable(manifest.status),
  });
}
