import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { matchRoot, type AllowedRoot } from "./roots.js";
import { errorCode, errorMessage } from "../values.js";
import { operationError } from "./types.js";

/** The most ancestor probes to keep in flight while validating a plan. */
const PROBE_CONCURRENCY = 8;

export interface AncestorProbe {
  /**
   * Whether the last path component is checked too.
   *
   * True only for a symlink target, because using the link follows it; for a path being mutated the
   * final component is what the operation replaces.
   */
  readonly includeFinalPath: boolean;
  readonly operationIndex: number;
  readonly path: string;
}

type PathKind = "directory" | "missing" | "other" | "symlink";

/**
 * Walks each probe from its allowed root down, rejecting any symbolic link along the way.
 *
 * Ancestors are shared across a plan's paths, so one cache turns a per-path walk into one `lstat`
 * per distinct directory. The cache holds the promise rather than the result, which also collapses
 * concurrent probes of the same ancestor into a single call.
 */
export async function runProbes(
  probes: readonly AncestorProbe[],
  roots: readonly AllowedRoot[],
  caseInsensitive: boolean,
): Promise<void> {
  const cache = new Map<string, Promise<PathKind>>();
  const failures = await mapWithConcurrency(probes, PROBE_CONCURRENCY, async (probe) => {
    try {
      await probeAncestors(probe, roots, caseInsensitive, cache);
      return undefined;
    } catch (error) {
      return error;
    }
  });

  // `probes` is in plan order, so the first failure is the earliest offending operation regardless
  // of how the probes interleaved.
  const failure = failures.find((entry) => entry !== undefined);
  if (failure !== undefined) {
    throw failure;
  }
}

async function probeAncestors(
  probe: AncestorProbe,
  roots: readonly AllowedRoot[],
  caseInsensitive: boolean,
  cache: Map<string, Promise<PathKind>>,
): Promise<void> {
  const resolvedPath = resolve(probe.path);
  const root = matchRoot(resolvedPath, roots, caseInsensitive);
  if (root === undefined) {
    return;
  }

  // An exact-file root is anchored at its own directory: the file is the leaf, not a container.
  const anchor = root.exact ? dirname(root.path) : root.path;
  if (!(await assertUsableRoot(anchor, probe.operationIndex, cache))) {
    return;
  }

  const destination = probe.includeFinalPath ? resolvedPath : dirname(resolvedPath);
  const difference = relative(anchor, destination);
  if (difference.length === 0) {
    return;
  }

  await walkComponents(anchor, difference.split(sep), probe, cache);
}

/** Checks each component below the anchor, stopping at the first one that does not exist yet. */
async function walkComponents(
  anchor: string,
  parts: readonly string[],
  probe: AncestorProbe,
  cache: Map<string, Promise<PathKind>>,
): Promise<void> {
  let current = anchor;

  for (const [partIndex, part] of parts.entries()) {
    current = join(current, part);
    const kind = await readPathKind(current, probe.operationIndex, cache);
    if (kind === "missing") {
      return;
    }

    const isFinal = partIndex === parts.length - 1;
    assertComponentUsable(current, kind, probe.includeFinalPath && isFinal, probe.operationIndex);
  }
}

function assertComponentUsable(
  path: string,
  kind: PathKind,
  mayBeNonDirectory: boolean,
  operationIndex: number,
): void {
  if (kind === "symlink") {
    throw operationError(
      "invalid-path",
      operationIndex,
      `path traverses a symbolic link: ${path}`,
      { path },
    );
  }
  if (kind !== "directory" && !mayBeNonDirectory) {
    throw operationError(
      "path-conflict",
      operationIndex,
      `path ancestor is not a directory: ${path}`,
      { path },
    );
  }
}

/** Returns false when the allowed root does not exist yet and may safely be created. */
async function assertUsableRoot(
  root: string,
  operationIndex: number,
  cache: Map<string, Promise<PathKind>>,
): Promise<boolean> {
  const rootKind = await readPathKind(root, operationIndex, cache);
  if (rootKind === "missing") {
    return false;
  }
  if (rootKind === "symlink") {
    throw operationError(
      "invalid-path",
      operationIndex,
      `allowed root is a symbolic link: ${root}`,
      {
        path: root,
      },
    );
  }
  if (rootKind !== "directory") {
    throw operationError(
      "path-conflict",
      operationIndex,
      `allowed root is not a directory: ${root}`,
      { path: root },
    );
  }
  return true;
}

function readPathKind(
  path: string,
  operationIndex: number,
  cache: Map<string, Promise<PathKind>>,
): Promise<PathKind> {
  const cached = cache.get(path);
  if (cached !== undefined) {
    return cached;
  }

  const pending = lstat(path).then<PathKind, PathKind>(
    (stats) => {
      if (stats.isSymbolicLink()) {
        return "symlink";
      }
      return stats.isDirectory() ? "directory" : "other";
    },
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") {
        return "missing";
      }
      throw operationError(
        "filesystem-error",
        operationIndex,
        `could not inspect path ancestor ${path}: ${errorMessage(error)}`,
        { cause: error, path },
      );
    },
  );

  cache.set(path, pending);
  return pending;
}

async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  run: (item: Item) => Promise<Result>,
): Promise<(Result | undefined)[]> {
  const results = Array.from<Result | undefined>({ length: items.length });
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await run(item);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      await worker();
    }),
  );
  return results;
}
