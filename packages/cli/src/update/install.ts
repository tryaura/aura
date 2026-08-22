import { randomUUID } from "node:crypto";
import { chmod, copyFile, link, lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acquireUpdateLock } from "./lock.js";
import { stageExecutable, type StageFailure } from "./stage.js";
import { isNewerVersion } from "./target.js";
import type { UpdateHost } from "./host.js";
import type { UpdateCandidate } from "./types.js";

/**
 * Why an attempt replaced nothing, beyond the digest mismatch that gets its own outcome.
 *
 * Carried rather than collapsed. The user sees one sentence whatever this says — the message
 * contract in `docs/cli-ux.md` does not branch on it — but a distribution author reading the debug
 * trace has to be able to tell an install directory they cannot write to from a release whose
 * archive the extractor refuses, and the two are otherwise the same silent nothing.
 */
type InstallFailure =
  | Exclude<StageFailure, "digest">
  /** The lock could not be created at all: an install directory this user cannot write to. */
  | "lock-unavailable"
  /** The path to replace stopped being a regular file between the gate and the transaction. */
  | "not-a-regular-file"
  /** A link, copy, or rename inside the swap threw. */
  | "replace-failed";

/**
 * What one installation attempt did.
 *
 * The three non-success outcomes are distinct because the user hears about them differently: a
 * contended lock says nothing, a failed replacement offers a manual path, and a digest mismatch is
 * the one that gets an explicit security warning.
 */
export type InstallOutcome =
  | { readonly kind: "installed" }
  /** Another updater holds the lock, or had already installed this release. */
  | { readonly kind: "skipped" }
  /** The bytes did not match the published digest. Nothing was staged over anything. */
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly reason: InstallFailure };

export interface InstallRequest {
  readonly candidate: UpdateCandidate;
  /** Distribution command name: the archive entry, and the base of the recovery copy's name. */
  readonly command: string;
  readonly downloadHeaders: Readonly<Record<string, string>>;
  /** What is left of the startup update's budget, which is all the transfer may spend. */
  readonly downloadTimeoutMs: number;
  readonly executablePath: string;
  readonly host: UpdateHost;
  readonly now: number;
  /** Drawn while the archive streams, when the caller has a terminal to draw on. */
  readonly onProgress?: ((received: number, total: number) => void) | undefined;
  readonly probeEnvironment: Readonly<Record<string, string>>;
}

/**
 * Replaces the running distribution's executable with a newer release, or changes nothing.
 *
 * The transaction is ordered so the installed executable is only ever touched by two renames, both
 * within one directory: a recovery copy moves into place, then the verified staged file moves over
 * the original. A crash at any earlier point leaves temporary files and nothing else; a crash
 * between the two renames leaves a working binary and a copy of it.
 */
export async function installUpdate(request: InstallRequest): Promise<InstallOutcome> {
  const directory = dirname(request.executablePath);
  const attempt = await acquireUpdateLock({
    host: request.host,
    lockPath: `${request.executablePath}.update-lock`,
    now: request.now,
  });
  if (attempt.kind !== "acquired") {
    return attempt.kind === "held"
      ? { kind: "skipped" }
      : { kind: "failed", reason: "lock-unavailable" };
  }
  try {
    return await transact(request, directory);
  } catch {
    return { kind: "failed", reason: "replace-failed" };
  } finally {
    await attempt.lock.release();
  }
}

async function transact(request: InstallRequest, directory: string): Promise<InstallOutcome> {
  // Re-asked under the lock: another updater may have finished between this run's eligibility
  // check and this moment, and installing the same release twice would replace a good binary with
  // an identical one while pointing the recovery copy at itself.
  const installed = await request.host.probeVersion(
    request.executablePath,
    request.probeEnvironment,
  );
  if (installed !== undefined && !isNewerVersion(request.candidate.version, installed)) {
    return { kind: "skipped" };
  }
  const executableMode = await regularFileMode(request.executablePath);
  if (executableMode === undefined) {
    return { kind: "failed", reason: "not-a-regular-file" };
  }

  // Every path the transaction can create is invented here, so the cleanup below names all of
  // them. One built deeper in — inside the swap, say — is one a failed rename leaves behind.
  const scratch = join(directory, `.${request.command}-${randomUUID()}`);
  const paths = {
    archive: `${scratch}.tar.gz`,
    license: `${scratch}.LICENSE`,
    previous: `${scratch}.previous`,
    staged: `${scratch}.staged`,
  };
  try {
    const failure = await stageExecutable({
      archivePath: paths.archive,
      candidate: request.candidate,
      downloadHeaders: request.downloadHeaders,
      downloadTimeoutMs: request.downloadTimeoutMs,
      entryName: request.command,
      executableMode,
      host: request.host,
      licensePath: paths.license,
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      probeEnvironment: request.probeEnvironment,
      stagedPath: paths.staged,
    });
    if (failure !== undefined) {
      return failure === "digest" ? { kind: "refused" } : { kind: "failed", reason: failure };
    }
    await swap(request, directory, paths);
    return { kind: "installed" };
  } finally {
    await discard([paths.archive, paths.license, paths.previous, paths.staged]);
  }
}

/** The two renames, in the order that leaves something runnable at every point between them. */
async function swap(
  request: InstallRequest,
  directory: string,
  paths: { readonly license: string; readonly previous: string; readonly staged: string },
): Promise<void> {
  await retainPrevious(request, paths.previous);
  await rename(paths.staged, request.executablePath);
  // After the executable, never before: a license replaced ahead of a rename that then fails would
  // leave the old binary beside the new release's text, with nothing left to put back.
  await replaceLicense(directory, paths.license);
  await syncDirectory(directory);
}

/**
 * Keeps one recovery copy beside the installed binary.
 *
 * A hard link costs no space and no read of a hundred-megabyte file; a copy is the fallback for
 * filesystems that refuse links. The intermediate rename is what makes the copy appear whole: a
 * reader either sees the previous `.previous` or the new one, never a partially written file.
 */
async function retainPrevious(request: InstallRequest, temporary: string): Promise<void> {
  try {
    await link(request.executablePath, temporary);
  } catch {
    await copyFile(request.executablePath, temporary);
  }
  await rename(temporary, `${request.executablePath}.previous`);
}

/**
 * Updates the license text only where the installation already keeps one.
 *
 * Replacing a file the original install wrote is maintenance; creating one it never wrote would
 * put an unexpected file into a directory Aura shares with whatever else lives on the user's path.
 */
async function replaceLicense(directory: string, staged: string): Promise<void> {
  const installed = join(directory, "LICENSE");
  // Both sides are optional: an archive may omit the file, and an installation may never have kept
  // one. Neither is a reason to abandon a transaction whose executable already verified.
  const mode = await regularFileMode(installed);
  if (mode === undefined || !(await isRegularFile(staged))) {
    return;
  }
  // The extractor writes every entry `0600`. Carrying the replaced file's own mode over is what
  // keeps a shared installation's license readable by the users who could read it before.
  await chmod(staged, mode);
  await rename(staged, installed);
}

/**
 * Flushes the directory entry itself where the platform supports it.
 *
 * Without this the renames can still be in the filesystem's own buffers after the process exits;
 * a power loss then leaves a directory that lists neither the old name nor the new one.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every platform allows opening a directory for sync. The renames themselves are atomic.
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  return (await regularFileMode(path)) !== undefined;
}

async function regularFileMode(path: string): Promise<number | undefined> {
  try {
    const status = await lstat(path);
    return status.isFile() ? status.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

async function discard(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rm(path, { force: true });
    } catch {
      // A temporary file that cannot be removed is not a reason to fail an install that worked.
    }
  }
}
