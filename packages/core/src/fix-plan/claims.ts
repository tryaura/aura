import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { operationError } from "./types.js";

/**
 * Which operation has claimed which path.
 *
 * Two operations touching the same file, or one touching a directory the other writes inside, would
 * make the second one's captured `before` state a lie. Indexing the ancestors of every claim turns
 * detecting that from a scan of all prior claims into a lookup.
 *
 * Consecutive writes to one literal path are the exception: they share a claim, and
 * `prepareWriteGroup` reconciles them against a single captured `before` by three-way merge. Every
 * other overlap is still a hard conflict.
 */
export interface ClaimIndex {
  /** Every ancestor directory of a claimed path, mapped to the operation that claimed it. */
  readonly ancestors: Map<string, number>;
  /** Each claimed path itself, mapped to the operation that claimed it. */
  readonly exact: Map<string, number>;
}

export function createClaimIndex(): ClaimIndex {
  return { ancestors: new Map(), exact: new Map() };
}

export function claimPath(
  claims: ClaimIndex,
  path: string,
  operationIndex: number,
  caseInsensitive: boolean,
  allowedExactOwner?: number | undefined,
): void {
  const resolvedPath = resolve(path);
  const key = comparablePath(resolvedPath, caseInsensitive);
  const ancestorKeys = ancestorsOf(resolvedPath).map((ancestor) =>
    comparablePath(ancestor, caseInsensitive),
  );

  // Three ways to overlap: the same path twice, a path inside an earlier one, or a path containing
  // an earlier one.
  const exactOwner = claims.exact.get(key);
  const conflict =
    (exactOwner === allowedExactOwner ? undefined : exactOwner) ??
    claims.ancestors.get(key) ??
    ancestorKeys
      .map((ancestorKey) => claims.exact.get(ancestorKey))
      .find((owner) => owner !== undefined);

  if (conflict !== undefined) {
    throw operationError(
      "path-conflict",
      operationIndex,
      `path overlaps operation ${conflict}: ${path}`,
      { path },
    );
  }

  if (exactOwner === undefined) {
    claims.exact.set(key, operationIndex);
  }
  for (const ancestorKey of ancestorKeys) {
    if (!claims.ancestors.has(ancestorKey)) {
      claims.ancestors.set(ancestorKey, operationIndex);
    }
  }
}

export function comparablePath(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

/**
 * Decides whether a volume distinguishes case, by looking for a directory under a flipped name.
 *
 * The answer matters because on a case-insensitive volume `AGENTS.md` and `agents.md` are one file:
 * treating them as two would let one operation quietly undo another. When the probe cannot decide —
 * a name with no letters to flip, or a directory that is not there — it answers insensitive, which
 * only ever widens overlap detection. Widening is safe because it can only ever raise a conflict:
 * coalescing deliberately does not key off this answer, since merging two spellings that turned out
 * to be different files would drop one of them.
 */
export async function detectCaseInsensitive(directory: string): Promise<boolean> {
  const flipped = flipCase(basename(directory));
  if (flipped === undefined) {
    return true;
  }

  let original: Stats;
  try {
    original = await lstat(directory);
  } catch {
    return true;
  }

  if (original.ino === 0) {
    return true;
  }

  try {
    const candidate = await lstat(join(dirname(directory), flipped));
    return original.ino === candidate.ino && original.dev === candidate.dev;
  } catch {
    // The flipped name resolves to nothing, so the volume kept the two apart.
    return false;
  }
}

function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(path);

  while (current !== path) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return ancestors;
}

function flipCase(name: string): string | undefined {
  const flipped = [...name]
    .map((character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
    )
    .join("");
  return flipped === name ? undefined : flipped;
}
