import { readFile, stat } from "node:fs/promises";

/** What core learned about one path on disk. */
export interface PathContents {
  /** File contents, absent for directories and for anything that could not be read. */
  readonly content?: string | undefined;
  /** Whether the path exists and could be inspected. */
  readonly exists: boolean;
  /** Whether the path is a directory. */
  readonly isDirectory: boolean;
}

/**
 * The only filesystem read path in the Aura kernel.
 *
 * Injected rather than imported so the model builder can be exercised against an in-memory
 * filesystem. It is deliberately absent from the SDK's {@link Environment}: adapters declare paths
 * and core reads them, so no plugin ever holds a handle to the filesystem.
 */
export interface FileReader {
  /** Reads one path. Resolves for every outcome, including missing paths, and never rejects. */
  readonly read: (path: string) => Promise<PathContents>;
}

/** The result for a path that does not exist or could not be inspected. */
const MISSING: PathContents = Object.freeze({ exists: false, isDirectory: false });

/** Creates the production {@link FileReader}, backed by `node:fs`. */
export function createFileReader(): FileReader {
  return Object.freeze({ read: readPath });
}

/**
 * Reads a path, mapping every filesystem error onto a {@link PathContents}.
 *
 * A scan touches paths that are routinely absent and occasionally unreadable, so an unreadable
 * path is a fact about the machine rather than an exception: it degrades that one entry instead of
 * failing the run.
 */
async function readPath(path: string): Promise<PathContents> {
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(path)).isDirectory();
  } catch {
    return MISSING;
  }

  if (isDirectory) {
    return { exists: true, isDirectory: true };
  }

  try {
    return { content: await readFile(path, "utf8"), exists: true, isDirectory: false };
  } catch {
    return { exists: true, isDirectory: false };
  }
}
