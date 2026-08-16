import { dirname, resolve, sep } from "node:path";

/** Where the current project sits, from the narrowest directory outward. */
export interface ProjectLookup {
  /** Directory Aura was invoked from. */
  readonly cwd: string;
  /** Repository root containing {@link ProjectLookup.cwd}, when one was found. */
  readonly projectRoot?: string | undefined;
}

/**
 * Every directory of the current project Codex consults, from `cwd` outward to the repository root.
 *
 * Two features need exactly this list. Codex keys `[projects."..."]` by the directory it was
 * launched in, which is frequently a subdirectory of the repository rather than its root, and it
 * reads one `AGENTS.md` per directory from the root down to `cwd`. Both are the same walk read in
 * opposite directions, so they share it rather than each keeping a copy.
 *
 * Without a repository root there is nothing to walk to: every ancestor of the working directory is
 * a different project as far as Codex is concerned, so only `cwd` is considered. The same answer
 * covers a `cwd` that is not inside the reported root at all, which is a contradiction Aura reports
 * rather than resolves.
 */
export function projectDirectories(lookup: ProjectLookup): readonly string[] {
  const cwd = resolve(lookup.cwd);
  if (lookup.projectRoot === undefined) {
    return [cwd];
  }

  const directories: string[] = [];
  const stop = resolve(lookup.projectRoot);
  let current = cwd;
  while (isWithin(current, stop)) {
    directories.push(current);
    if (current === stop) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories.length === 0 ? [cwd] : directories;
}

/** Every logical ancestor from `cwd` through the filesystem root, with no arbitrary depth cap. */
export function ancestorDirectories(cwd: string): readonly string[] {
  const directories: string[] = [];
  let current = resolve(cwd);
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
