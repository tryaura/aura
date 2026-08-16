import { lstat, readFile, rm } from "node:fs/promises";

import { errorCode } from "./error-values.js";

const LOCK_STALE_MS = 5 * 60 * 1000;
const UNREADABLE_LOCK_GRACE_MS = 5 * 1000;

export interface LockOwner {
  readonly acquiredAt: string;
  readonly acquiredAtMs: number;
  /** Absent only on a singleton lock written by an older Aura build. */
  readonly ownerId?: string | undefined;
  readonly pid: number;
}

export type InspectedLock =
  | { readonly kind: "active"; readonly owner?: LockOwner | undefined }
  | { readonly kind: "missing" }
  | { readonly kind: "stale"; readonly owner?: LockOwner | undefined };

export async function inspectLock(path: string, now: () => Date): Promise<InspectedLock> {
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

/** Removes a lock only while it still holds the record the caller inspected. */
export async function removeObservedLock(
  path: string,
  observed: LockOwner | undefined,
): Promise<void> {
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

function sameOwner(left: LockOwner | undefined, right: LockOwner): boolean {
  return (
    left !== undefined &&
    left.pid === right.pid &&
    left.acquiredAtMs === right.acquiredAtMs &&
    left.ownerId === right.ownerId
  );
}
