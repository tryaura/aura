import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { inspectLock, removeObservedLock, type LockOwner } from "./journal-lock-record.js";
import { errorCode, errorMessage, FixPlanError } from "./types.js";

const LOCK_NAME = ".lock";
const LOCK_SUFFIX = ".json";

interface HeldLock {
  readonly owner: LockOwner;
  readonly path: string;
}

/** Serializes every decision and mutation involving the undo journal. */
export async function withJournalLock<Result>(
  root: string,
  now: () => Date,
  action: () => Promise<Result>,
): Promise<Result> {
  return withLockDirectory(join(root, LOCK_NAME), "the undo journal", now, action);
}

/**
 * Serializes work behind one on-disk lock directory.
 *
 * `subject` names what the lock protects, so a contention error tells the user what another run is
 * busy with rather than which directory happened to hold the lock.
 */
export async function withLockDirectory<Result>(
  directory: string,
  subject: string,
  now: () => Date,
  action: () => Promise<Result>,
): Promise<Result> {
  const lock = await acquire(directory, subject, now);
  try {
    return await action();
  } finally {
    await release(lock);
  }
}

async function acquire(directory: string, subject: string, now: () => Date): Promise<HeldLock> {
  try {
    await ensureLockDirectory(directory, subject, now);
    const lock = await publishLock(directory, now());
    try {
      const contenders = await activeContenders(directory, now, lock.path);
      if (contenders.length > 0) {
        throw lockedError(directory, subject);
      }
      return lock;
    } catch (error) {
      await removeOwnedLock(lock);
      throw error;
    }
  } catch (error) {
    if (error instanceof FixPlanError) {
      throw error;
    }
    throw new FixPlanError("backup-error", `could not lock ${subject}: ${errorMessage(error)}`, {
      cause: error,
      path: directory,
    });
  }
}

/** Unique entries in a permanent directory make stale cleanup ownership-safe. */
async function ensureLockDirectory(
  directory: string,
  subject: string,
  now: () => Date,
): Promise<void> {
  while (true) {
    const state = await lockDirectoryState(directory);
    if (state === "ready") {
      return;
    }
    if (state === "retry") {
      continue;
    }
    // A non-recursive rm cannot delete a directory installed by a competing legacy-lock migrator.
    const observed = await inspectLock(directory, now);
    if (observed.kind !== "stale") {
      throw lockedError(directory, subject);
    }
    await removeLegacyLock(directory);
  }
}

async function lockDirectoryState(directory: string): Promise<"legacy" | "ready" | "retry"> {
  try {
    await mkdir(directory, { mode: 0o700 });
    return "ready";
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }

  try {
    return (await lstat(directory)).isDirectory() ? "ready" : "legacy";
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "retry";
    }
    throw error;
  }
}

async function removeLegacyLock(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "EISDIR") {
      throw error;
    }
  }
}

async function publishLock(directory: string, taken: Date): Promise<HeldLock> {
  const ownerId = randomUUID();
  const owner: LockOwner = {
    acquiredAt: taken.toISOString(),
    acquiredAtMs: taken.getTime(),
    ownerId,
    pid: process.pid,
  };
  const path = join(directory, `${ownerId}${LOCK_SUFFIX}`);
  const temporaryPath = join(directory, `.${ownerId}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
  } finally {
    await handle.close();
  }

  try {
    // Publish the completed record exclusively so readers never observe an empty lock.
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { owner, path };
}

async function activeContenders(
  directory: string,
  now: () => Date,
  ownPath: string,
): Promise<readonly string[]> {
  const contenders: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if (path === ownPath || !name.endsWith(LOCK_SUFFIX)) {
      continue;
    }

    const inspected = await inspectLock(path, now);
    if (inspected.kind === "missing") {
      continue;
    }
    if (inspected.kind === "stale") {
      await removeObservedLock(path, inspected.owner);
      continue;
    }
    contenders.push(path);
  }
  return contenders;
}

async function release(lock: HeldLock): Promise<void> {
  await removeOwnedLock(lock).catch(() => undefined);
}

async function removeOwnedLock(lock: HeldLock): Promise<void> {
  await removeObservedLock(lock.path, lock.owner);
}

function lockedError(path: string, subject: string): FixPlanError {
  return new FixPlanError(
    "backup-error",
    `another Aura run is using ${subject}. Wait for it to finish, or delete ${path} if no Aura process is running.`,
    { path },
  );
}
