import type { AdapterPathKind, FileProblem } from "@tryaura/aura-sdk";

import { createLimiter } from "./concurrency.js";
import { readPathWithin } from "./reader-bounded.js";
import { inspectPath, pathExists, readPath, resolveRealPath } from "./reader-filesystem.js";

export { MAX_DIRECTORY_ENTRIES, MAX_FILE_BYTES } from "./reader-limits.js";

/** How many filesystem operations may be in flight at once. */
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
  /**
   * Permission bits of a regular file, absent for everything else.
   *
   * Core holds its own protocol files at a fixed mode, so a planner that decides whether to rewrite
   * one has to be able to see the mode it currently has. Deliberately not forwarded to adapters:
   * `toStatus` whitelists what {@link AdapterFileStatus} carries, and a plugin has no business
   * reading permission bits off a path it merely declared.
   */
  readonly mode?: number | undefined;
  /**
   * Last content write of a regular file, in epoch milliseconds; absent for everything else.
   *
   * Session discovery prunes transcripts by this before opening them: a file whose last write
   * predates the analysis window cannot hold a session that started inside it.
   */
  readonly mtimeMs?: number | undefined;
  /** Kind of the final path entry without following a symbolic link. */
  readonly pathKind?: AdapterPathKind | undefined;
  /** Why no contents were captured, when the reason was something other than absence. */
  readonly problem?: FileProblem | undefined;
  /** Size of a regular file or resolved symlink target, before any requested truncation. */
  readonly size?: number | undefined;
  /** Raw target of the final path entry when it is a symbolic link. */
  readonly symlinkTarget?: string | undefined;
  /**
   * Present only when a regular-file read that captured the whole file did not decode as strict
   * UTF-8. A read truncated by {@link FileReadOptions.maxBytes} ends mid-sequence by construction
   * and so leaves this absent rather than reporting a break it caused itself.
   */
  readonly utf8Valid?: false | undefined;
}

/** Optional bounds for one content read. */
export interface FileReadOptions {
  /** Capture at most this many bytes, returning the same UTF-8 prefix the application consumes. */
  readonly maxBytes?: number | undefined;
}

/**
 * One read whose target was checked against a boundary before any file contents were captured.
 *
 * The three outcomes are kept apart because they mean three different things to a user. `outside`
 * is the security event — a declared path that led out of the project, named by where it led.
 * `unverified` is not: it says the object under the path moved while it was being read, which an
 * editor saving a file mid-scan does as readily as an attacker, and describing that as an escape
 * would accuse a user's own repository of something it did not do.
 */
export type BoundedPathRead =
  | {
      readonly contents: PathContents;
      readonly kind: "read";
      /** Canonical target of the object that was read, when one resolved. */
      readonly resolvedPath?: string | undefined;
    }
  | {
      readonly contents: PathContents;
      readonly kind: "outside";
      /** Canonical target that landed outside every requested directory. Always known. */
      readonly resolvedPath: string;
    }
  | {
      readonly contents: PathContents;
      readonly kind: "unverified";
    };

/** The filesystem access core supplies to adapters indirectly through declared file specs. */
export interface FileReader {
  /** Whether a path is there, without opening it. */
  readonly exists: (path: string) => Promise<boolean>;
  /** Inspects one path without opening a regular file or enumerating a directory. */
  readonly inspect?: ((path: string) => Promise<PathContents>) | undefined;
  /** Reads one path. Resolves for every outcome, including missing paths, and never rejects. */
  readonly read: (path: string, options?: FileReadOptions) => Promise<PathContents>;
  /** Reads only when the opened target is inside one of `directories`. */
  readonly readWithin: (
    path: string,
    directories: readonly string[],
    options?: FileReadOptions,
  ) => Promise<BoundedPathRead>;
  /** Resolves a path through symlinks, or `undefined` when it does not resolve. */
  readonly realPath: (path: string) => Promise<string | undefined>;
}

/** Creates the production {@link FileReader}, backed by `node:fs`. */
export function createFileReader(): FileReader {
  const limit = createLimiter(MAX_CONCURRENT_OPERATIONS);

  return Object.freeze({
    exists: (path: string) => limit(() => pathExists(path)),
    inspect: (path: string) => limit(() => inspectPath(path)),
    read: (path: string, options?: FileReadOptions) => limit(() => readPath(path, options)),
    readWithin: (path: string, directories: readonly string[], options?: FileReadOptions) =>
      limit(() => readPathWithin(path, directories, options)),
    realPath: (path: string) => limit(() => resolveRealPath(path)),
  });
}

/** Wraps a reader so each operation and bound is evaluated at most once per scan. */
export function createCachingReader(reader: FileReader): FileReader {
  const contents = new Map<string, Promise<PathContents>>();
  const inspections = new Map<string, Promise<PathContents>>();
  const presence = new Map<string, Promise<boolean>>();
  const scopedContents = new Map<string, Promise<BoundedPathRead>>();
  const realPaths = new Map<string, Promise<string | undefined>>();

  return Object.freeze({
    exists: (path: string) => memoize(presence, path, () => reader.exists(path)),
    inspect: (path: string) =>
      memoize(inspections, path, () =>
        reader.inspect === undefined
          ? reader.read(path).then(withoutContents)
          : reader.inspect(path),
      ),
    read: (path: string, options?: FileReadOptions) =>
      memoize(contents, contentCacheKey(path, options), () => reader.read(path, options)),
    readWithin: (path: string, directories: readonly string[], options?: FileReadOptions) =>
      memoize(scopedContents, boundedCacheKey(path, directories, options), () =>
        reader.readWithin(path, directories, options),
      ),
    realPath: (path: string) => memoize(realPaths, path, () => reader.realPath(path)),
  });
}

function boundedCacheKey(
  path: string,
  directories: readonly string[],
  options: FileReadOptions | undefined,
): string {
  return `${contentCacheKey(path, options)}\0${directories.join("\0")}`;
}

function contentCacheKey(path: string, options: FileReadOptions | undefined): string {
  return `${path}\0${options?.maxBytes === undefined ? "all" : String(options.maxBytes)}`;
}

function withoutContents(contents: PathContents): PathContents {
  return {
    exists: contents.exists,
    isDirectory: contents.isDirectory,
    ...(contents.pathKind === undefined ? {} : { pathKind: contents.pathKind }),
    ...(contents.problem === undefined ? {} : { problem: contents.problem }),
    ...(contents.size === undefined ? {} : { size: contents.size }),
    ...(contents.symlinkTarget === undefined ? {} : { symlinkTarget: contents.symlinkTarget }),
  };
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
