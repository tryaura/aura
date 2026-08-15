import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { errorCode, errorMessage, FixPlanError } from "./types.js";

const LOCK_NAME = ".lock";
const LOCK_SUFFIX = ".json";

/** How long a lock may sit untouched before a later run checks whether its process is gone. */
const LOCK_STALE_MS = 5 * 60 * 1000;

/** Corrupt foreign records remain a wall briefly instead of being mistaken for half-written locks. */
const UNREADABLE_LOCK_GRACE_MS = 5 * 1000;

interface LockOwner {
  readonly acquiredAt: string;
  readonly acquiredAtMs: number;
  /** Absent only on a singleton lock written by an older Aura build. */
  readonly ownerId?: string | undefined;
  readonly pid: number;
}

interface HeldLock {
  readonly owner: LockOwner;
  readonly path: string;
}

/**
 * Serializes everything that reads or writes the journal.
 *
 * Applying and undoing both decide what to do from the state of the store and the filesystem, then
 * act on that decision. Without a lock two runs can make the same decision — two undos selecting one
 * entry, or an undo restoring paths an apply is still mutating — and the per-path preconditions only
 * catch some of the ways that goes wrong.
 */
export async function withJournalLock<Result>(
  root: string,
  now: () => Date,
  action: () => Promise<Result>,
): Promise<Result> {
  const lock = await acquire(join(root, LOCK_NAME), now);
  try {
    return await action();
  } finally {
    await release(lock);
  }
}

async function acquire(directory: string, now: () => Date): Promise<HeldLock> {
  try {
    await ensureLockDirectory(directory, now);
    const lock = await publishLock(directory, now());
    try {
      const contenders = await activeContenders(directory, now, lock.path);
      if (contenders.length > 0) {
        throw lockedError(directory);
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
    throw new FixPlanError(
      "backup-error",
      `could not lock the undo journal: ${errorMessage(error)}`,
      { cause: error, path: directory },
    );
  }
}

/**
 * The directory is permanent and each acquisition publishes a unique entry inside it. That makes
 * stale cleanup ownership-safe: removing an old entry can never remove a newer process's lock.
 */
async function ensureLockDirectory(directory: string, now: () => Date): Promise<void> {
  while (true) {
    const state = await lockDirectoryState(directory);
    if (state === "ready") {
      return;
    }
    if (state === "retry") {
      continue;
    }
    // Migrate a singleton lock created by an older Aura build. A competing migrator can replace the
    // file with the directory between these calls; rm without `recursive` cannot delete that directory.
    const observed = await inspectLock(directory, now);
    if (observed.kind !== "stale") {
      throw lockedError(directory);
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
    // The completed temporary file becomes visible in one exclusive operation. Readers never see
    // the empty-file window produced by opening the public lock path before writing its contents.
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

type InspectedLock =
  | { readonly kind: "active"; readonly owner?: LockOwner | undefined }
  | { readonly kind: "missing" }
  | { readonly kind: "stale"; readonly owner?: LockOwner | undefined };

async function inspectLock(path: string, now: () => Date): Promise<InspectedLock> {
  try {
    const owner = parseOwner(await readFile(path, "utf8"));
    if (owner === undefined) {
      return (await unreadableLockIsStale(path, now)) ? { kind: "stale" } : { kind: "active" };
    }
    if (now().getTime() - owner.acquiredAtMs <= LOCK_STALE_MS || processIsAlive(owner.pid)) {
      return { kind: "active", owner };
    }
    return { kind: "stale", owner };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "missing" };
    }
    return (await unreadableLockIsStale(path, now)) ? { kind: "stale" } : { kind: "active" };
  }
}

async function unreadableLockIsStale(path: string, now: () => Date): Promise<boolean> {
  try {
    return now().getTime() - (await lstat(path)).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseOwner(text: string): LockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const acquiredAt = lockAcquiredAt(parsed);
  const acquiredAtMs = lockAcquiredAtMs(parsed);
  const pid = lockPid(parsed);
  if (acquiredAt === undefined || acquiredAtMs === undefined || pid === undefined) {
    return undefined;
  }
  return {
    acquiredAt,
    acquiredAtMs,
    ownerId: "ownerId" in parsed && typeof parsed.ownerId === "string" ? parsed.ownerId : undefined,
    pid,
  };
}

function lockAcquiredAt(parsed: object): string | undefined {
  return "acquiredAt" in parsed && typeof parsed.acquiredAt === "string"
    ? parsed.acquiredAt
    : undefined;
}

function lockAcquiredAtMs(parsed: object): number | undefined {
  return "acquiredAtMs" in parsed &&
    typeof parsed.acquiredAtMs === "number" &&
    Number.isFinite(parsed.acquiredAtMs)
    ? parsed.acquiredAtMs
    : undefined;
}

function lockPid(parsed: object): number | undefined {
  return "pid" in parsed &&
    typeof parsed.pid === "number" &&
    Number.isInteger(parsed.pid) &&
    parsed.pid > 0
    ? parsed.pid
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function release(lock: HeldLock): Promise<void> {
  await removeOwnedLock(lock).catch(() => undefined);
}

async function removeOwnedLock(lock: HeldLock): Promise<void> {
  await removeObservedLock(lock.path, lock.owner);
}

async function removeObservedLock(path: string, observed: LockOwner | undefined): Promise<void> {
  if (observed !== undefined) {
    let current: LockOwner | undefined;
    try {
      current = parseOwner(await readFile(path, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    if (!sameOwner(current, observed)) {
      return;
    }
  }
  await rm(path, { force: true });
}

function sameOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return (
    left !== undefined &&
    left.pid === right.pid &&
    left.acquiredAtMs === right.acquiredAtMs &&
    left.ownerId === right.ownerId
  );
}

function lockedError(path: string): FixPlanError {
  return new FixPlanError(
    "backup-error",
    `another Aura run is using the undo journal. Wait for it to finish, or delete ${path} if no Aura process is running.`,
    { path },
  );
}
