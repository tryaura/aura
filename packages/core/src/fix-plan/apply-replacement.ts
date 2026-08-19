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
import { revalidateSymlinkTarget } from "./path-policy.js";
import type {
  PreparedPlanState,
  PreparedSymlinkOperation,
  PreparedWriteOperation,
} from "./prepared.js";

export async function applySymlink(
  prepared: PreparedSymlinkOperation,
  plan: PreparedPlanState,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem,
): Promise<void> {
  const { path, target } = prepared.operation;
  const index = prepared.preview.index;
  const before = prepared.before;

  await verifyPath(path, before, index, plan);
  await revalidateSymlinkTarget(target, plan.policy, index);
  const parents = createdParents(dirname(path));
  const state = registerReplacementUndo(
    path,
    before,
    true,
    parents,
    index,
    registerUndo,
    filesystem,
  );
  await ensureDirectory(parents, filesystem);
  await replaceLink(path, target, filesystem);
  state.changed = true;
}

export async function applyWrite(
  prepared: PreparedWriteOperation,
  plan: PreparedPlanState,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem,
): Promise<void> {
  const path = prepared.operation.path;
  const index = prepared.preview.index;
  const before = prepared.before;
  // Decided in `prepareWrite`, so what lands on disk is what the preview showed.
  const mode = prepared.mode;

  await verifyPath(path, before, index, plan);
  const parents = createdParents(dirname(path));
  const state = registerReplacementUndo(
    path,
    before,
    prepared.contentsChanged,
    parents,
    index,
    registerUndo,
    filesystem,
  );

  await ensureDirectory(parents, filesystem);
  if (before.kind === "missing") {
    // `wx` neither follows a symbolic link that appeared since the check nor clobbers a file.
    await filesystem.writeFile(path, prepared.operation.content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    state.changed = true;
    // Create mode is masked by umask; the plan's closed mode set is enforced exactly.
    await filesystem.chmod(path, mode);
    return;
  }

  if (before.kind === "file" && !prepared.contentsChanged) {
    // Identical bytes, so the file keeps its inode and timestamp and only the mode is corrected.
    await filesystem.chmodNoFollow(path, mode);
  } else {
    await replaceFile(path, prepared.operation.content, mode, filesystem);
  }
  state.changed = true;
}

interface ReplacementState {
  changed: boolean;
}

function registerReplacementUndo(
  path: string,
  before: PreparedSymlinkOperation["before"],
  contentsChanged: boolean,
  parents: ReturnType<typeof createdParents>,
  index: number,
  registerUndo: RegisterUndo,
  filesystem: MutationFileSystem,
): ReplacementState {
  const state: ReplacementState = { changed: false };
  registerUndo({
    cleanup: cleanupParents(parents, filesystem),
    hasEffects: () => state.changed || parents.created !== undefined,
    index,
    undo: async () => {
      if (state.changed) {
        await restoreReplacement(path, before, contentsChanged, filesystem);
        state.changed = false;
      }
    },
  });
  return state;
}

async function restoreReplacement(
  path: string,
  before: PreparedSymlinkOperation["before"],
  contentsChanged: boolean,
  filesystem: MutationFileSystem,
): Promise<void> {
  if (before.kind === "missing") {
    await filesystem.rm(path, { force: true });
  } else if (before.kind === "file") {
    if (contentsChanged) {
      await restoreFile(path, before, filesystem);
    } else {
      await filesystem.chmodNoFollow(path, before.mode);
    }
  } else {
    await replaceLink(path, before.target, filesystem);
  }
}
