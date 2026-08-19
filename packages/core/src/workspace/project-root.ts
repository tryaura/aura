import { basename, dirname, join, resolve } from "node:path";

import type { FileReader } from "./reader.js";

/**
 * Finds the repository root containing `cwd`, walking up until the filesystem root.
 *
 * Matches on `.git` whether it is a directory or the file a worktree leaves behind, so a scan run
 * from a linked worktree resolves the same project scope as one run from a clone.
 */
export async function findProjectRoot(
  cwd: string,
  reader: FileReader,
): Promise<string | undefined> {
  let directory = cwd;

  for (;;) {
    const marker = await reader.read(join(directory, ".git"));
    if (marker.exists) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

/**
 * Resolves the primary checkout Git uses as the trust boundary for a repository.
 *
 * A normal checkout keeps a `.git` directory and is its own primary checkout. A linked worktree
 * keeps a `gitdir:` file pointing at `<primary>/.git/worktrees/<id>` instead, so the primary
 * checkout is recovered from that standard Git layout without requiring the Git executable.
 */
export async function findGitMainWorktreeRoot(
  projectRoot: string,
  reader: FileReader,
): Promise<string | undefined> {
  const marker = await reader.read(join(projectRoot, ".git"));
  if (marker.problem !== undefined || !marker.exists) {
    return undefined;
  }
  if (marker.isDirectory) {
    return projectRoot;
  }
  if (marker.content === undefined) {
    return undefined;
  }

  const pointer = marker.content
    .trim()
    .match(/^gitdir:\s*(.+)$/u)?.[1]
    ?.trim();
  if (pointer === undefined || pointer.length === 0) {
    return undefined;
  }

  const gitDirectory = resolve(projectRoot, pointer);
  const worktreesDirectory = dirname(gitDirectory);
  if (basename(worktreesDirectory) !== "worktrees") {
    return undefined;
  }

  const mainWorktreeRoot = dirname(dirname(worktreesDirectory));
  return (await reader.realPath(mainWorktreeRoot)) ?? mainWorktreeRoot;
}
