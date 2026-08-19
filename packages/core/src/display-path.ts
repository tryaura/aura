import { isAbsolute, relative, sep } from "node:path";

/** The roots a displayed path is shortened against, most specific first. */
export interface PathDisplayRoots {
  /** Where the command was invoked, used when the run is not inside a repository. */
  readonly cwd: string;
  /** The user's home directory, which becomes the `~/` prefix. */
  readonly homeDir: string;
  /** The repository root, when the run is inside one. */
  readonly projectRoot?: string | undefined;
}

/**
 * Names a path the way a user can address it from where they ran the command.
 *
 * Project-relative first, then `~/`, then the path unchanged. Every renderer goes through this so
 * one report cannot show the same file two ways — a check that bakes a path into its message and
 * the CLI that prints that finding's locations must agree, or the two lines read as two files.
 */
export function displayPath(path: string, roots: PathDisplayRoots): string {
  const project = pathInside(roots.projectRoot ?? roots.cwd, path);
  if (project !== undefined) {
    return project;
  }
  const home = pathInside(roots.homeDir, path);
  return home === undefined ? path : `~/${home}`;
}

function pathInside(root: string, path: string): string | undefined {
  const difference = relative(root, path);
  if (
    difference.length === 0 ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    return undefined;
  }
  return difference.split(sep).join("/");
}
