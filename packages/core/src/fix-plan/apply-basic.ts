import { dirname } from "node:path";

import {
  cleanupParents,
  createdParents,
  ensureDirectory,
  restoreFile,
  verifyPath,
  type RegisterUndo,
} from "./apply-support.js";
import { replaceFile, replaceLink, type MutationFileSystem } from "./filesystem.js";
import { revalidateMutationPath, revalidateSymlinkTarget } from "./path-policy.js";
import type {
  PreparedArchiveOperation,
  PreparedMoveOperation,
  PreparedPlanState,
  PreparedRemoveOperation,
} from "./prepared.js";
import { inspectPath, type PathState } from "./state.js";
import { operationError } from "./types.js";

export async function applyArchive(
  prepared: PreparedArchiveOperation,
  plan: PreparedPlanState,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem,
): Promise<void> {
  const { path, replacement } = prepared.operation;
  const index = prepared.preview.index;
  await verifyPath(path, prepared.before, index, plan);
  let changed = false;
  registerUndo({
    hasEffects: () => changed,
    index,
    undo: async () => {
      await restoreFile(path, prepared.before, filesystem);
      changed = false;
    },
  });

  if (replacement === undefined) {
    await filesystem.unlink(path);
  } else if (replacement.type === "symlink") {
    await revalidateSymlinkTarget(replacement.target, plan.policy, index);
    await replaceLink(path, replacement.target, filesystem);
  } else {
    await replaceFile(
      path,
      replacement.content,
      prepared.replacementMode ?? prepared.before.mode,
      filesystem,
    );
  }
  changed = true;
}

export async function applyMove(
  prepared: PreparedMoveOperation,
  plan: PreparedPlanState,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem,
): Promise<void> {
  const { destinationPath, sourcePath } = prepared.operation;
  const index = prepared.preview.index;

  await verifyPath(sourcePath, prepared.sourceBefore, index, plan);
  await verifyPath(destinationPath, prepared.destinationBefore, index, plan);
  const parents = createdParents(dirname(destinationPath));
  let moved = false;
  registerUndo({
    cleanup: cleanupParents(parents, filesystem),
    hasEffects: () => moved || parents.created !== undefined,
    index,
    undo: async () => {
      if (moved) {
        await filesystem.rename(destinationPath, sourcePath);
        moved = false;
      }
    },
  });
  await ensureDirectory(parents, filesystem);
  await filesystem.rename(sourcePath, destinationPath);
  moved = true;
}

export async function applyRemove(
  prepared: PreparedRemoveOperation,
  plan: PreparedPlanState,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem,
): Promise<void> {
  const path = prepared.operation.path;
  const index = prepared.preview.index;
  const before = prepared.before;

  if (prepared.removalGroupDirectory === true && before.kind === "directory") {
    await verifyEmptiedDirectory(path, before, index, plan);
  } else {
    await verifyPath(path, before, index, plan);
  }

  let removed = false;
  if (before.kind === "directory") {
    registerUndo({
      hasEffects: () => removed,
      index,
      undo: async () => {
        // The mode goes to `mkdir` as well as `chmod`, so a directory that was owner-only never
        // exists at the umask default, however briefly.
        await filesystem.mkdir(path, { mode: before.mode });
        await filesystem.chmod(path, before.mode);
        await filesystem.utimes(path, before.modifiedTimeMs / 1000, before.modifiedTimeMs / 1000);
        removed = false;
      },
    });
    await filesystem.rmdir(path);
    removed = true;
    return;
  }

  registerUndo({
    hasEffects: () => removed,
    index,
    undo: async () => {
      if (before.kind === "file") {
        await restoreFile(path, before, filesystem);
      } else {
        await filesystem.symlink(before.target, path);
      }
      removed = false;
    },
  });
  await filesystem.unlink(path);
  removed = true;
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
