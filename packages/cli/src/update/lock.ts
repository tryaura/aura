import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, stat, unlink } from "node:fs/promises";

import { LOCK_STALE_MS } from "./limits.js";
import { asRecord, asSize, parseJson } from "./narrow.js";
import type { UpdateHost } from "./host.js";

/** A held lock. Releasing is best-effort: a lock that outlives its holder is recoverable. */
interface UpdateLock {
  readonly release: () => Promise<void>;
}

/**
 * The outcome of one attempt on the lock.
 *
 * `held` and `unavailable` are kept apart because the user hears about them differently: another
 * updater working on the same executable is not an event, while a directory this user cannot write
 * to is the thing they need to know in order to update at all.
 */
export type LockAttempt =
  | { readonly kind: "acquired"; readonly lock: UpdateLock }
  | { readonly kind: "held" }
  | { readonly kind: "unavailable" };

export interface LockRequest {
  readonly host: UpdateHost;
  readonly lockPath: string;
  readonly now: number;
}

/**
 * Takes the per-executable update lock, or gives up.
 *
 * Exclusive creation is the whole mechanism: two updaters racing on the same executable both call
 * `open(…, "wx")` and exactly one succeeds. Losing is not an error — the other process is already
 * installing the same release, and the command the user asked for runs either way.
 */
export async function acquireUpdateLock(request: LockRequest): Promise<LockAttempt> {
  const attempt = await claim(request);
  if (attempt.kind !== "held") {
    return attempt;
  }
  return (await reclaimStale(request)) ? claim(request) : attempt;
}

async function claim(request: LockRequest): Promise<LockAttempt> {
  const token = randomUUID();
  try {
    const handle = await open(request.lockPath, "wx", 0o600);
    try {
      await handle.write(JSON.stringify({ pid: request.host.pid, startedAt: request.now, token }));
    } finally {
      await handle.close();
    }
    return { kind: "acquired", lock: { release: () => removeOwned(request.lockPath, token) } };
  } catch (error) {
    // Only an existing lock means someone else is working. Anything else — a directory this user
    // cannot write to, a full disk — is a failure the user can act on.
    const held = error instanceof Error && "code" in error && error.code === "EEXIST";
    return { kind: held ? "held" : "unavailable" };
  }
}

/**
 * Removes a lock whose owner is gone.
 *
 * Both conditions are required. Age alone would break a slow but healthy download on a thin
 * connection; a missing process alone would race a holder that has not written its record yet.
 * An unreadable or malformed lock counts as expired once it is old enough — nothing that can be
 * asked about it will ever answer.
 */
async function reclaimStale(request: LockRequest): Promise<boolean> {
  const contents = await read(request.lockPath);
  const record = asRecord(parseJson(contents));
  const startedAt =
    asSize(record?.["startedAt"], Number.MAX_SAFE_INTEGER) ?? (await modifiedAt(request.lockPath));
  if (startedAt === undefined || request.now - startedAt < LOCK_STALE_MS) {
    return false;
  }
  const pid = asSize(record?.["pid"], Number.MAX_SAFE_INTEGER);
  if (pid !== undefined && request.host.isProcessAlive(pid)) {
    return false;
  }
  return await removeUnchanged(request.lockPath, contents);
}

/**
 * When the lock file was last written, used when its contents cannot say.
 *
 * An updater killed between creating the lock and writing its record leaves a file that names no
 * process. Without this fallback that file would block every future update on the machine.
 */
async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function remove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // A lock already gone is the state releasing wanted.
  }
}

/** Removes a stale lock only while it is still the exact record that was inspected. */
async function removeUnchanged(path: string, expected: string): Promise<boolean> {
  // Every reclaimer inspecting the same record derives the same hard-link path. Creating that link
  // is the atomic election: only one process may proceed to unlink the shared lock name.
  const fingerprint = createHash("sha256").update(expected, "utf8").digest("hex").slice(0, 16);
  const reclaimPath = `${path}.reclaim-${fingerprint}`;
  try {
    await link(path, reclaimPath);
  } catch {
    return false;
  }
  try {
    // The path may have changed between inspection and the hard link. The link snapshots whichever
    // inode won that race, so comparing its contents prevents removing a successor.
    if ((await read(reclaimPath)) !== expected || (await read(path)) !== expected) {
      return false;
    }
    await unlink(path);
    return true;
  } catch {
    return false;
  } finally {
    await remove(reclaimPath);
  }
}

/** A holder must never unlink a successor that reused the same path. */
async function removeOwned(path: string, token: string): Promise<void> {
  const record = asRecord(parseJson(await read(path)));
  if (record?.["token"] === token) {
    await remove(path);
  }
}
