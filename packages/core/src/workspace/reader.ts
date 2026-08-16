import type { Stats } from "node:fs";
import { lstat, opendir, readFile, readlink, realpath, stat } from "node:fs/promises";

import type { AdapterPathKind, FileProblem } from "@tryaura/aura-sdk";

import { createLimiter } from "./concurrency.js";

/**
 * The largest file Aura reads, in bytes.
 *
 * Mirrors the ceiling on captured exec output. A scan touches paths whose size it does not choose,
 * so one oversized file must not be able to exhaust the process. Oversized files are refused
 * rather than truncated: half a config parses into confident wrong findings, which is worse than
 * no findings at all.
 */
export const MAX_FILE_BYTES = 10_000_000;

/** The most directory entries Aura lists, for the same reason as {@link MAX_FILE_BYTES}. */
export const MAX_DIRECTORY_ENTRIES = 10_000;

/**
 * How many filesystem operations may be in flight at once.
 *
 * Adapters scan concurrently and each declares several paths, so without a ceiling the open
 * descriptor count grows with adapters times specs. Running out surfaces as `EMFILE`, and a scan
 * that reports real files as unreadable because it opened too many at once is a scan that reports
 * findings about a machine it never actually saw.
 */
const MAX_CONCURRENT_OPERATIONS = 24;

/** What core learned about one path on disk. */
export interface PathContents {
  /** File contents, absent for directories and for anything that could not be read. */
  readonly content?: string | undefined;
  /** Sorted names of a directory's immediate children. Absent for anything but a directory. */
  readonly entries?: readonly string[] | undefined;
  /** Whether the path exists and could be inspected. */
  readonly exists: boolean;
  /** Whether the path is a directory. */
  readonly isDirectory: boolean;
  /** Kind of the final path entry without following a symbolic link. */
  readonly pathKind?: AdapterPathKind | undefined;
  /** Why no contents were captured, when the reason was something other than absence. */
  readonly problem?: FileProblem | undefined;
  /** Raw target of the final path entry when it is a symbolic link. */
  readonly symlinkTarget?: string | undefined;
}

/**
 * The only filesystem read path in the Aura kernel.
 *
 * Injected rather than imported so the model builder can be exercised against an in-memory
 * filesystem. It is deliberately absent from the SDK's {@link Environment}: adapters declare paths
 * and core reads them, so no plugin ever holds a handle to the filesystem.
 */
export interface FileReader {
  /** Whether a path is there, without opening it. See {@link pathExists}. */
  readonly exists: (path: string) => Promise<boolean>;
  /** Reads one path. Resolves for every outcome, including missing paths, and never rejects. */
  readonly read: (path: string) => Promise<PathContents>;
  /**
   * Resolves a path through symlinks to its canonical location, or `undefined` when it does not
   * resolve. Used to keep project-scoped reads inside the project they claim to describe.
   */
  readonly realPath: (path: string) => Promise<string | undefined>;
}

/** The result for a path that does not exist. */
const MISSING: PathContents = Object.freeze({ exists: false, isDirectory: false });

/** Creates the production {@link FileReader}, backed by `node:fs`. */
export function createFileReader(): FileReader {
  const limit = createLimiter(MAX_CONCURRENT_OPERATIONS);

  return Object.freeze({
    exists: (path: string) => limit(() => pathExists(path)),
    read: (path: string) => limit(() => readPath(path)),
    realPath: (path: string) => limit(() => resolveRealPath(path)),
  });
}

/**
 * Whether a path is there, deciding it exactly as {@link readPath} decides `exists`: `lstat`
 * succeeding is the whole test, so a dangling symlink is present and a denied parent is not.
 *
 * Kept apart from reading because instruction links are answered with existence alone, and a
 * project document's link targets are named by whatever repository the user checked out. Opening
 * one would pull the bytes of an arbitrary absolute path into the scan to answer yes or no.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wraps a reader so each path is read at most once per scan.
 *
 * Applications share instruction files — one `~/AGENTS.md` is declared by every adapter that reads
 * it and pointed at by every document that imports it — so without this the same path is read once
 * per adapter and again per link.
 */
export function createCachingReader(reader: FileReader): FileReader {
  const contents = new Map<string, Promise<PathContents>>();
  const presence = new Map<string, Promise<boolean>>();
  const realPaths = new Map<string, Promise<string | undefined>>();

  return Object.freeze({
    exists: (path: string) => memoize(presence, path, () => reader.exists(path)),
    read: (path: string) => memoize(contents, path, () => reader.read(path)),
    realPath: (path: string) => memoize(realPaths, path, () => reader.realPath(path)),
  });
}

function memoize<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const pending = cache.get(key);
  if (pending !== undefined) {
    return pending;
  }

  const value = load();
  cache.set(key, value);
  return value;
}

/**
 * Reads a path, mapping every filesystem outcome onto a {@link PathContents}.
 *
 * A scan touches paths that are routinely absent and occasionally unreadable, so an unreadable
 * path is a fact about the machine rather than an exception: it degrades that one entry instead of
 * failing the run. What it is not is a *missing* path — the two produce very different advice, so
 * they stay distinct all the way to the user.
 */
async function readPath(path: string): Promise<PathContents> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    return isAbsence(error) ? MISSING : { ...MISSING, problem: toProblem(error) };
  }

  if (stats.isSymbolicLink()) {
    return readSymbolicLink(path);
  }

  if (stats.isDirectory()) {
    return readResolvedPath(path, stats, "directory");
  }
  if (!stats.isFile()) {
    return { exists: true, isDirectory: false, problem: "unsupported" };
  }
  return readResolvedPath(path, stats, "file");
}

async function readSymbolicLink(path: string): Promise<PathContents> {
  let symlinkTarget: string;
  try {
    symlinkTarget = await readlink(path);
  } catch (error) {
    return {
      exists: true,
      isDirectory: false,
      pathKind: "symlink",
      problem: toProblem(error),
    };
  }

  let targetStats: Stats;
  try {
    targetStats = await stat(path);
  } catch (error) {
    return isAbsence(error)
      ? { exists: true, isDirectory: false, pathKind: "symlink", symlinkTarget }
      : {
          exists: true,
          isDirectory: false,
          pathKind: "symlink",
          problem: toProblem(error),
          symlinkTarget,
        };
  }

  return readResolvedPath(path, targetStats, "symlink", symlinkTarget);
}

async function readResolvedPath(
  path: string,
  stats: Stats,
  pathKind: AdapterPathKind,
  symlinkTarget?: string,
): Promise<PathContents> {
  const metadata = {
    pathKind,
    ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
  };

  if (stats.isDirectory()) {
    return readDirectory(path, metadata);
  }

  // Sockets, FIFOs and device files are not configuration, and reading one is not a bounded
  // operation: a FIFO blocks until someone writes to it, a character device never ends. Project
  // paths are built from cwd, so a hostile checkout must not be able to reach readFile at all.
  if (!stats.isFile()) {
    return { ...metadata, exists: true, isDirectory: false, problem: "unsupported" };
  }

  if (stats.size > MAX_FILE_BYTES) {
    return { ...metadata, exists: true, isDirectory: false, problem: "too-large" };
  }

  try {
    return {
      ...metadata,
      content: await readFile(path, "utf8"),
      exists: true,
      isDirectory: false,
    };
  } catch (error) {
    return { ...metadata, exists: true, isDirectory: false, problem: toProblem(error) };
  }
}

/** Lists a directory one level deep, in sorted order so two scans of one machine agree. */
async function readDirectory(
  path: string,
  metadata: Pick<PathContents, "pathKind" | "symlinkTarget">,
): Promise<PathContents> {
  const entries: string[] = [];

  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        // Leaving the loop early closes the handle, so the oversized directory costs nothing more.
        return { ...metadata, exists: true, isDirectory: true, problem: "too-many-entries" };
      }

      entries.push(entry.name);
    }
  } catch (error) {
    return { ...metadata, exists: true, isDirectory: true, problem: toProblem(error) };
  }

  return { ...metadata, entries: entries.sort(), exists: true, isDirectory: true };
}

async function resolveRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Whether the error means the path is simply not there, as opposed to not readable. */
function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function toProblem(error: unknown): FileProblem {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM": {
      return "denied";
    }
    case "ELOOP": {
      return "loop";
    }
    case "EMFILE":
    case "ENFILE":
    case "ENOMEM": {
      return "resources";
    }
    case "EISDIR":
    case "ENXIO": {
      return "unsupported";
    }
    default: {
      return "unreadable";
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return undefined;
}
