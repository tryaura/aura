import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { backupRoot, MANIFEST_NAME, MAX_JOURNAL_ENTRIES } from "./journal-paths.js";
import { entryNames, type JournalHandle } from "./journal-read.js";
import { storeOperation } from "./journal-store.js";
import {
  JOURNAL_VERSION,
  type JournalManifest,
  type JournalStatus,
  type StoredOperation,
} from "./journal-schema.js";
import type { ApplicableOperation, PreparedPlanState } from "./prepared.js";
import { errorCode, errorMessage } from "./error-values.js";
import { FixPlanError } from "./types.js";

/** Creates the store, refusing to write through a symbolic link planted where it belongs. */
export async function ensureBackupRoot(homeDir: string): Promise<string> {
  const home = resolve(homeDir);
  const root = backupRoot(home);
  await assertRealDirectories(home, root);
  await mkdir(root, { mode: 0o700, recursive: true });
  await assertRealDirectories(home, root);
  await chmod(root, 0o700);
  return root;
}

/** Opens the store for reading, or returns undefined when nothing has ever been staged. */
export async function openBackupRoot(homeDir: string): Promise<string | undefined> {
  const home = resolve(homeDir);
  const root = backupRoot(home);
  await assertRealDirectories(home, root);
  try {
    await lstat(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new FixPlanError("backup-error", `could not open undo journal: ${errorMessage(error)}`, {
      cause: error,
      path: root,
    });
  }
  return root;
}

export async function stageJournal(
  plan: PreparedPlanState,
  operations: readonly ApplicableOperation[],
  now: () => Date,
): Promise<JournalHandle> {
  const root = backupRoot(plan.model.homeDir);
  let allocatedDirectory: string | undefined;
  try {
    const createdAt = now();
    const { directory, id } = await allocateDirectory(root, timestamp(createdAt));
    allocatedDirectory = directory;
    await mkdir(join(directory, "files"), { mode: 0o700 });
    const stored: StoredOperation[] = [];
    const virtualDirectories = new Set<string>();
    for (const operation of operations) {
      stored.push(await storeOperation(operation, directory, virtualDirectories));
    }
    const manifest: JournalManifest = {
      caseInsensitive: plan.policy.caseInsensitive,
      createdAt: createdAt.toISOString(),
      homeDir: resolve(plan.model.homeDir),
      id,
      operations: Object.freeze(stored),
      roots: Object.freeze(plan.policy.roots.map((entry) => ({ ...entry }))),
      status: "pending",
      version: JOURNAL_VERSION,
    };
    await writeManifest(directory, manifest);
    await pruneJournal(root, id);
    return { directory, manifest };
  } catch (error) {
    if (allocatedDirectory !== undefined) {
      await rm(allocatedDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
    if (error instanceof FixPlanError) {
      throw error;
    }
    throw new FixPlanError(
      "backup-error",
      `could not stage fix-plan backup: ${errorMessage(error)}`,
      {
        cause: error,
        path: root,
      },
    );
  }
}

export async function setJournalStatus(
  handle: JournalHandle,
  status: JournalStatus,
  undoneAt?: string,
): Promise<JournalHandle> {
  const manifest: JournalManifest = {
    ...handle.manifest,
    status,
    undoneAt,
  };
  await writeManifest(handle.directory, manifest);
  return { directory: handle.directory, manifest };
}

/** Drops the oldest entries past {@link MAX_JOURNAL_ENTRIES}, never the one just staged. */
async function pruneJournal(root: string, keep: string): Promise<void> {
  try {
    const names = await entryNames(root);
    await Promise.all(
      names
        .slice(MAX_JOURNAL_ENTRIES)
        .filter((name) => name !== keep)
        .map(async (name) => rm(join(root, name), { force: true, recursive: true })),
    );
  } catch {
    // A store that grew past its ceiling is worth less than a plan that applied. The next entry
    // staged tries again.
  }
}

/**
 * Rejects a journal path that is not the real directory it appears to be.
 *
 * Everything else in the kernel refuses to follow a final symbolic link, and the store has to hold
 * the same line: `mkdir` with `recursive` follows one silently, so a link planted at `~/agents` or
 * `~/agents/.backups` would send every captured file — the previous contents of the user's own
 * configuration — somewhere else, and hand whoever planted it the manifests undo trusts.
 */
async function assertRealDirectories(home: string, root: string): Promise<void> {
  let current = home;
  // Only the components Aura owns are checked. Whether the home directory itself is reached through
  // a link is the user's arrangement, and is already implicit in every other path in the model.
  for (const part of relative(home, root).split(sep)) {
    current = join(current, part);
    let isRealDirectory: boolean;
    try {
      const stats = await lstat(current);
      isRealDirectory = stats.isDirectory() && !stats.isSymbolicLink();
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw new FixPlanError(
        "backup-error",
        `could not inspect the undo journal path: ${errorMessage(error)}`,
        { cause: error, path: current },
      );
    }
    if (!isRealDirectory) {
      throw new FixPlanError(
        "backup-error",
        `the undo journal path is not a real directory: ${current}. Move or delete it, then run the fix again.`,
        { path: current },
      );
    }
  }
}

async function allocateDirectory(
  root: string,
  base: string,
): Promise<{ readonly directory: string; readonly id: string }> {
  for (let sequence = await nextSequence(root, base); sequence < 10_000; sequence += 1) {
    const id = sequence === 0 ? base : `${base}-${String(sequence).padStart(4, "0")}`;
    const directory = join(root, id);
    try {
      await mkdir(directory, { mode: 0o700 });
      return { directory, id };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new FixPlanError("backup-error", `could not allocate a backup directory under ${root}`);
}

/**
 * The first tiebreaker after the highest one this timestamp has already used.
 *
 * Starting from zero would be enough to find a free name, but not to keep the names in order:
 * retention deletes the oldest entries, so the low tiebreakers a same-second timestamp already
 * spent come free again, and reusing one would file a new entry behind the entries it follows.
 */
async function nextSequence(root: string, base: string): Promise<number> {
  let next = 0;
  for (const name of await entryNames(root)) {
    if (name === base) {
      next = Math.max(next, 1);
      continue;
    }
    if (!name.startsWith(`${base}-`)) {
      continue;
    }
    const sequence = Number.parseInt(name.slice(base.length + 1), 10);
    if (Number.isInteger(sequence)) {
      next = Math.max(next, sequence + 1);
    }
  }
  return next;
}

async function writeManifest(directory: string, manifest: JournalManifest): Promise<void> {
  const path = join(directory, MANIFEST_NAME);
  const temporary = join(directory, `.${MANIFEST_NAME}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function timestamp(value: Date): string {
  return value.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
