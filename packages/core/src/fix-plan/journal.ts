import type { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseManifest } from "./journal-parse.js";
import { storeOperation } from "./journal-store.js";
import {
  JOURNAL_VERSION,
  type JournalManifest,
  type JournalStatus,
  type StoredPathState,
} from "./journal-schema.js";
import { isApplicable, type PreparedPlanState } from "./prepared.js";
import { errorCode, errorMessage, FixPlanError } from "./types.js";

const BACKUP_DIRECTORY = join("agents", ".backups");
const MANIFEST_NAME = "manifest.json";

export interface JournalHandle {
  readonly directory: string;
  readonly manifest: JournalManifest;
}

export function backupRoot(homeDir: string): string {
  return resolve(homeDir, BACKUP_DIRECTORY);
}

export async function stageJournal(
  plan: PreparedPlanState,
  now: () => Date,
): Promise<JournalHandle | undefined> {
  const operations = plan.operations.filter(isApplicable);
  if (operations.length === 0) {
    return undefined;
  }

  const root = backupRoot(plan.model.homeDir);
  try {
    const createdAt = now();
    await mkdir(root, { mode: 0o700, recursive: true });
    await chmod(root, 0o700);
    const { directory, id } = await allocateDirectory(root, timestamp(createdAt));
    await mkdir(join(directory, "files"), { mode: 0o700 });
    const stored = await Promise.all(
      operations.map((operation) => storeOperation(operation, directory)),
    );
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
    return { directory, manifest };
  } catch (error) {
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

export async function listJournal(homeDir: string): Promise<readonly JournalHandle[]> {
  const root = backupRoot(homeDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw new FixPlanError("backup-error", `could not read undo journal: ${errorMessage(error)}`, {
      cause: error,
      path: root,
    });
  }

  const handles: JournalHandle[] = [];
  for (const name of names.sort().reverse()) {
    const directory = join(root, name);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      throw new FixPlanError(
        "backup-error",
        `could not inspect undo entry: ${errorMessage(error)}`,
        {
          cause: error,
          path: directory,
        },
      );
    }
    if (!stats.isDirectory()) {
      continue;
    }
    const path = join(directory, MANIFEST_NAME);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new FixPlanError(
        "journal-corrupt",
        `could not read journal manifest: ${errorMessage(error)}`,
        {
          cause: error,
          path,
        },
      );
    }
    const manifest = parseManifest(text, path);
    if (manifest.id !== name || resolve(manifest.homeDir) !== resolve(homeDir)) {
      throw new FixPlanError(
        "journal-corrupt",
        `journal identity does not match its location: ${path}`,
        {
          path,
        },
      );
    }
    handles.push({ directory, manifest });
  }
  return Object.freeze(handles);
}

export async function readPayload(directory: string, state: StoredPathState): Promise<Buffer> {
  if (state.kind !== "file" || state.payload === undefined) {
    throw new FixPlanError("journal-corrupt", "journal file state has no payload", {
      path: directory,
    });
  }
  const path = join(directory, state.payload);
  try {
    return await readFile(path);
  } catch (error) {
    throw new FixPlanError(
      "journal-corrupt",
      `could not read backup payload: ${errorMessage(error)}`,
      {
        cause: error,
        path,
      },
    );
  }
}

async function allocateDirectory(
  root: string,
  base: string,
): Promise<{ readonly directory: string; readonly id: string }> {
  for (let sequence = 0; sequence < 10_000; sequence += 1) {
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
