import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { errorCode, errorMessage, FixPlanError } from "./types.js";

const LOCK_NAME = ".lock";

/** How long a lock may sit untouched before a later run treats the process that took it as gone. */
const LOCK_STALE_MS = 5 * 60 * 1000;

/** One retry is enough: the only reason to try again is having just cleared a stale lock. */
const LOCK_ATTEMPTS = 2;

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
  const path = join(root, LOCK_NAME);
  await acquire(path, now);
  try {
    return await action();
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function acquire(path: string, now: () => Date): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        const taken = now();
        // The readable form is for whoever inspects a stuck lock; the epoch form is what staleness
        // is measured against, so deciding it never reaches for the system clock.
        await handle.writeFile(
          `${JSON.stringify({
            acquiredAt: taken.toISOString(),
            acquiredAtMs: taken.getTime(),
            pid: process.pid,
          })}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new FixPlanError(
          "backup-error",
          `could not lock the undo journal: ${errorMessage(error)}`,
          { cause: error, path },
        );
      }
      if (!(await isStale(path, now))) {
        throw new FixPlanError(
          "backup-error",
          `another Aura run is using the undo journal. Wait for it to finish, or delete ${path} if no Aura process is running.`,
          { path },
        );
      }
      await rm(path, { force: true });
    }
  }

  throw new FixPlanError("backup-error", `could not lock the undo journal: ${path}`, { path });
}

/** A lock whose holder left it behind. An unreadable one counts as stale rather than as a wall. */
async function isStale(path: string, now: () => Date): Promise<boolean> {
  let acquiredAtMs: unknown;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    acquiredAtMs =
      typeof parsed === "object" && parsed !== null && "acquiredAtMs" in parsed
        ? parsed.acquiredAtMs
        : undefined;
  } catch {
    return true;
  }

  if (typeof acquiredAtMs !== "number" || !Number.isFinite(acquiredAtMs)) {
    return true;
  }
  return now().getTime() - acquiredAtMs > LOCK_STALE_MS;
}
