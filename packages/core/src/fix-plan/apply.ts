import {
  chmod,
  mkdir,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import { removeCreatedDirectories, replaceFile, replaceLink } from "./filesystem.js";
import { revalidateMutationPath, revalidateSymlinkTarget } from "./path-policy.js";
import type {
  ApplicableOperation,
  PreparedArchiveOperation,
  PreparedMoveOperation,
  PreparedPlanState,
  PreparedRemoveOperation,
  PreparedSymlinkOperation,
  PreparedWriteOperation,
} from "./prepared.js";
import { inspectPath, statesEqual, type CapturedFileState, type PathState } from "./state.js";
import { operationError } from "./types.js";

type UndoAction = () => Promise<void>;

/** An applied operation together with the single action that puts it back. */
export interface UndoStep {
  readonly index: number;
  readonly undo: UndoAction;
}

/** The only function in the kernel that turns a prepared fix operation into filesystem writes. */
export async function applyPreparedOperation(
  prepared: ApplicableOperation,
  plan: PreparedPlanState,
): Promise<UndoStep> {
  switch (prepared.type) {
    case "archive": {
      return applyArchive(prepared, plan);
    }
    case "move": {
      return applyMove(prepared, plan);
    }
    case "remove": {
      return applyRemove(prepared, plan);
    }
    case "symlink": {
      return applySymlink(prepared, plan);
    }
    case "write": {
      return applyWrite(prepared, plan);
    }
  }
}

async function applyArchive(
  prepared: PreparedArchiveOperation,
  plan: PreparedPlanState,
): Promise<UndoStep> {
  const { path, replacement } = prepared.operation;
  const index = prepared.preview.index;
  await verifyPath(path, prepared.before, index, plan);

  if (replacement === undefined) {
    await unlink(path);
  } else if (replacement.type === "symlink") {
    await revalidateSymlinkTarget(replacement.target, plan.policy, index);
    await replaceLink(path, replacement.target);
  } else {
    await replaceFile(path, replacement.content, prepared.replacementMode ?? prepared.before.mode);
  }

  return undoStep(index, undefined, async () => restoreFile(path, prepared.before));
}

async function applyMove(
  prepared: PreparedMoveOperation,
  plan: PreparedPlanState,
): Promise<UndoStep> {
  const { destinationPath, sourcePath } = prepared.operation;
  const index = prepared.preview.index;

  await verifyPath(sourcePath, prepared.sourceBefore, index, plan);
  await verifyPath(destinationPath, prepared.destinationBefore, index, plan);
  const undoDirectory = await ensureDirectory(dirname(destinationPath));
  await rename(sourcePath, destinationPath);

  return undoStep(index, undoDirectory, async () => {
    await rename(destinationPath, sourcePath);
  });
}

async function applyRemove(
  prepared: PreparedRemoveOperation,
  plan: PreparedPlanState,
): Promise<UndoStep> {
  const path = prepared.operation.path;
  const index = prepared.preview.index;
  const before = prepared.before;

  if (prepared.removalGroupDirectory === true && before.kind === "directory") {
    await verifyEmptiedDirectory(path, before, index, plan);
  } else {
    await verifyPath(path, before, index, plan);
  }

  if (before.kind === "directory") {
    await rmdir(path);
    return undoStep(index, undefined, async () => {
      await mkdir(path);
      await chmod(path, before.mode);
      await utimes(path, before.modifiedTimeMs / 1000, before.modifiedTimeMs / 1000);
    });
  }

  await unlink(path);

  if (before.kind === "file") {
    return undoStep(index, undefined, async () => {
      await restoreFile(path, before);
    });
  }

  return undoStep(index, undefined, async () => {
    await symlink(before.target, path);
  });
}

async function verifyEmptiedDirectory(
  path: string,
  expected: Extract<PathState, { readonly kind: "directory" }>,
  operationIndex: number,
  plan: PreparedPlanState,
): Promise<void> {
  await revalidateMutationPath(path, plan.policy, operationIndex);
  const current = await inspectPath(path, operationIndex, 0);
  if (current.kind !== "directory" || !current.empty || current.mode !== expected.mode) {
    throw operationError(
      "filesystem-changed",
      operationIndex,
      `directory did not become empty through its removal group: ${path}`,
      { path },
    );
  }
}

async function applySymlink(
  prepared: PreparedSymlinkOperation,
  plan: PreparedPlanState,
): Promise<UndoStep> {
  const { path, target } = prepared.operation;
  const index = prepared.preview.index;
  const before = prepared.before;

  await verifyPath(path, before, index, plan);
  await revalidateSymlinkTarget(target, plan.policy, index);
  const undoDirectory = await ensureDirectory(dirname(path));
  await replaceLink(path, target);

  if (before.kind === "missing") {
    return undoStep(index, undoDirectory, async () => {
      await rm(path, { force: true });
    });
  }
  if (before.kind === "file") {
    return undoStep(index, undoDirectory, async () => {
      await restoreFile(path, before);
    });
  }

  return undoStep(index, undoDirectory, async () => {
    await replaceLink(path, before.target);
  });
}

async function applyWrite(
  prepared: PreparedWriteOperation,
  plan: PreparedPlanState,
): Promise<UndoStep> {
  const path = prepared.operation.path;
  const index = prepared.preview.index;
  const before = prepared.before;
  // Decided in `prepareWrite`, so what lands on disk is what the preview showed.
  const mode = prepared.mode;

  await verifyPath(path, before, index, plan);
  const undoDirectory = await ensureDirectory(dirname(path));

  if (before.kind === "missing") {
    // `wx` is O_CREAT|O_EXCL: it neither follows a symbolic link that appeared since the check nor
    // clobbers a file that did.
    await writeFile(path, prepared.operation.content, { encoding: "utf8", flag: "wx", mode });
    // `mode` on create is masked by the process umask, and the modes a plan may ask for are a
    // closed, deliberate set. Set it exactly.
    await chmod(path, mode);
    return undoStep(index, undoDirectory, async () => {
      await rm(path, { force: true });
    });
  }

  if (before.kind === "file") {
    await replaceFile(path, prepared.operation.content, mode);
    return undoStep(index, undoDirectory, async () => {
      await restoreFile(path, before);
    });
  }

  await replaceFile(path, prepared.operation.content, mode);
  return undoStep(index, undoDirectory, async () => {
    await replaceLink(path, before.target);
  });
}

/** Puts a captured file back exactly as it was read, timestamp included. */
async function restoreFile(path: string, state: CapturedFileState): Promise<void> {
  await replaceFile(path, state.content, state.mode);
  await utimes(path, state.modifiedTimeMs / 1000, state.modifiedTimeMs / 1000);
}

/** Creates missing parents, returning an undo for whatever it had to create. */
async function ensureDirectory(path: string): Promise<UndoAction | undefined> {
  const created = await mkdir(path, { recursive: true });
  if (created === undefined) {
    return undefined;
  }

  return async () => {
    await removeCreatedDirectories(created, path);
  };
}

function undoStep(
  index: number,
  undoDirectory: UndoAction | undefined,
  undo: UndoAction,
): UndoStep {
  return {
    index,
    undo: async () => {
      await undo();
      if (undoDirectory !== undefined) {
        await undoDirectory();
      }
    },
  };
}

async function verifyPath(
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
