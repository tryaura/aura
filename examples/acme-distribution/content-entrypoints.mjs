import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every file below `content/` that the compiled binary must carry.
 *
 * Bun embeds only the files named as build entrypoints, and a skill file left off the command line
 * does not fail the build: the executable ships a skill tree quietly missing that file. Deriving
 * the list from the directory is what keeps the two in step, so both `build.mjs` and the
 * repository's release verification read it from here rather than spelling out filenames.
 *
 * @param root Distribution directory holding `content/`.
 * @returns Paths relative to `root`, POSIX-spelled for Bun's command line.
 */
export async function contentEntrypoints(root) {
  const paths = await readdir(join(root, "content"), { recursive: true });
  return paths
    .filter((path) => path.endsWith(".md") || path.endsWith(".json"))
    .map((path) => `content/${path.replaceAll("\\", "/")}`)
    .sort();
}
