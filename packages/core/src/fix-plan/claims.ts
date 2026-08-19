import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  /** Every ancestor directory of a claimed path, mapped to all operations below it. */
  readonly ancestors: Map<string, Set<number>>;
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
  allowedNestedOwners?: ReadonlySet<number> | undefined,
): void {
  const resolvedPath = resolve(path);
  const key = comparablePath(resolvedPath, caseInsensitive);
  const ancestorKeys = ancestorsOf(resolvedPath).map((ancestor) =>
    comparablePath(ancestor, caseInsensitive),
  );

  // Three ways to overlap: the same path twice, a path inside an earlier one, or a path containing
  // an earlier one.
  const exactOwner = claims.exact.get(key);
  const descendantOwner = [...(claims.ancestors.get(key) ?? [])].find(
    (owner) => allowedNestedOwners?.has(owner) !== true,
  );
  const ancestorOwner = ancestorKeys
    .map((ancestorKey) => claims.exact.get(ancestorKey))
    .find((owner) => owner !== undefined && allowedNestedOwners?.has(owner) !== true);
  const conflict =
    (exactOwner === allowedExactOwner ? undefined : exactOwner) ?? descendantOwner ?? ancestorOwner;

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
    const owners = claims.ancestors.get(ancestorKey);
    if (owners === undefined) {
      claims.ancestors.set(ancestorKey, new Set([operationIndex]));
    } else {
      owners.add(operationIndex);
    }
  }
}

export function comparablePath(path: string, caseInsensitive: boolean): string {
  return caseInsensitive ? path.toLowerCase() : path;
}

/** What a volume does with case, or `unknown` when the probe could not tell. */
export type CaseSensitivity = "insensitive" | "sensitive" | "unknown";

/**
 * Decides whether a volume distinguishes case, by looking for a directory under a flipped spelling.
 *
 * The answer matters because on a case-insensitive volume `AGENTS.md` and `agents.md` are one file:
 * treating them as two would let one operation quietly undo another. Every letter of the path is
 * flipped rather than only its last component, so a directory named for a year still gets a real
 * answer from the component above it.
 *
 * `unknown` is reported rather than guessed, because the two callers need opposite defaults: overlap
 * detection widens under it and root matching narrows (see {@link PathPolicy.caseInsensitive} and
 * {@link PathPolicy.rootsCaseInsensitive}). Collapsing both into one optimistic boolean is what
 * would let an undecided probe grant a write instead of merely refusing one.
 */
export async function detectCaseSensitivity(directory: string): Promise<CaseSensitivity> {
  const flipped = flipCase(directory);
  if (flipped === undefined) {
    return "unknown";
  }

  let original: Stats;
  try {
    original = await lstat(directory);
  } catch {
    return "unknown";
  }

  if (original.ino === 0) {
    return "unknown";
  }

  try {
    const candidate = await lstat(flipped);
    return original.ino === candidate.ino && original.dev === candidate.dev
      ? "insensitive"
      : "sensitive";
  } catch {
    // The flipped spelling resolves to nothing, so the volume kept the two apart.
    return "sensitive";
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
