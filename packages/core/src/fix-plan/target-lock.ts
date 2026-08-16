import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { comparablePath } from "./claims.js";
import { withLockDirectory } from "./journal-lock.js";

const TARGET_LOCKS_NAME = ".target-locks";

/**
 * The global files a plan mutates, deduplicated and ordered for lock acquisition.
 *
 * Project-scoped paths are excluded: files inside the working tree belong to one repository, so two
 * Aura runs cannot reach the same one from different directories the way they reach `~/.claude.json`.
 * The stable sort order is what lets two runs that share several targets acquire their locks without
 * deadlocking each other.
 */
export function globalTargetPaths(
  paths: readonly string[],
  projectRoot: string,
  caseInsensitive: boolean,
): readonly string[] {
  const targets = new Set<string>();
  for (const path of paths) {
    if (!withinProject(projectRoot, path)) {
      targets.add(comparablePath(path, caseInsensitive));
    }
  }
  return Object.freeze([...targets].sort());
}

/**
 * Holds one lock per global target file for the duration of `action`.
 *
 * Each lock is a directory under the backup root named after the target's path digest, using the
 * same publish-then-scan contender protocol as the journal lock — PID-liveness decides staleness,
 * and only the record an owner published is ever removed. Locks live beside the journal rather than
 * beside each target so that taking one can never dirty a directory Aura was only asked to read.
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
  await mkdir(join(root, TARGET_LOCKS_NAME), { mode: 0o700, recursive: true });
  return lockNext(targets, 0, root, now, action);
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

  const directory = join(root, TARGET_LOCKS_NAME, digest(target));
  return withLockDirectory(directory, target, now, async () =>
    lockNext(targets, index + 1, root, now, action),
  );
}

function digest(target: string): string {
  return createHash("sha256").update(target, "utf8").digest("hex");
}

/** Returns true when `candidate` is the project root or sits inside it. */
function withinProject(projectRoot: string, candidate: string): boolean {
  const difference = relative(resolve(projectRoot), resolve(candidate));
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}
