import { createHash } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { comparablePath } from "./claims.js";
import { withLockDirectory } from "./journal-lock.js";

const TARGET_LOCKS_NAME = ".target-locks";

/**
 * The files a plan mutates, normalized, deduplicated, and ordered for lock acquisition.
 *
 * Every target is included because two runs can use different home overrides while sharing a project.
 * Resolving before hashing makes syntactic aliases such as `/repo/./file` take the same lock. The
 * stable sort order lets two runs that share several targets acquire their locks without deadlocking.
 */
export function targetPaths(paths: readonly string[], caseInsensitive: boolean): readonly string[] {
  const targets = new Set<string>();
  for (const path of paths) {
    targets.add(comparablePath(resolve(path), caseInsensitive));
  }
  return Object.freeze([...targets].sort());
}

/**
 * Holds one lock per target file for the duration of `action`.
 *
 * Each lock is a directory in an owner-only shared-state store named after the target's path digest,
 * using the same publish-then-scan contender protocol as the journal lock. The CLI derives this root
 * from the home captured before `--home`, so its runs contend on the same target namespace.
 */
export async function withTargetLocks<Result>(
  targets: readonly string[],
  root: string,
  now: () => Date,
  action: () => Promise<Result>,
): Promise<Result> {
  if (targets.length === 0) {
    return action();
  }
  const store = join(root, TARGET_LOCKS_NAME);
  await mkdir(store, { mode: 0o700, recursive: true });
  return lockNext(targets, 0, store, now, action);
}

async function lockNext<Result>(
  targets: readonly string[],
  index: number,
  root: string,
  now: () => Date,
  action: () => Promise<Result>,
): Promise<Result> {
  const target = targets[index];
  if (target === undefined) {
    return action();
  }

  const directory = join(root, digest(target));
  try {
    return await withLockDirectory(directory, target, now, async () =>
      lockNext(targets, index + 1, root, now, action),
    );
  } finally {
    // Every run takes a lock named after a target digest, so without cleanup the store grows by
    // one directory per file ever locked. Removal is strictly best-effort: a concurrent run may
    // have just published its own record (ENOTEMPTY) or removed the directory first (ENOENT), and
    // either outcome leaves a correct store — the directory is recreated on demand — so failures
    // are deliberately swallowed rather than surfaced from a plan that already ran.
    await rmdir(directory).catch(() => undefined);
  }
}

function digest(target: string): string {
  return createHash("sha256").update(target, "utf8").digest("hex");
}
