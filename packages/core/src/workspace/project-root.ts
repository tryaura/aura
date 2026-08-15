import { dirname, join } from "node:path";

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
