import type { Buffer } from "node:buffer";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseManifest } from "./journal-parse.js";
import { ENTRY_NAME, MANIFEST_NAME } from "./journal-paths.js";
import type { JournalManifest, StoredPathState } from "./journal-schema.js";
import { errorCode, errorMessage } from "../values.js";
import { FixPlanError } from "./types.js";

export interface JournalHandle {
  readonly directory: string;
  readonly manifest: JournalManifest;
}

/**
 * One directory in the store.
 *
 * An entry that cannot be read is reported rather than thrown, because the store outlives any single
 * build: a half-staged entry from a killed run, or one written by a version that is not this one,
 * must not stop the entries around it from being undone.
 */
export type JournalEntry =
  | { readonly handle: JournalHandle; readonly id: string; readonly kind: "readable" }
  | { readonly id: string; readonly kind: "unreadable"; readonly reason: string };

/**
 * Yields entries newest first, reading each one only when it is asked for.
 *
 * Undo wants exactly one entry, and the store holds every plan the user has applied. Parsing all of
 * them to answer "what is the most recent undoable entry" costs more with every plan applied.
 */
export async function* readJournal(root: string, homeDir: string): AsyncGenerator<JournalEntry> {
  for (const id of await entryNames(root)) {
    const directory = join(root, id);
    let isDirectory: boolean;
    try {
      isDirectory = (await lstat(directory)).isDirectory();
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw new FixPlanError(
        "backup-error",
        `could not inspect undo entry: ${errorMessage(error)}`,
        { cause: error, path: directory },
      );
    }
    if (isDirectory) {
      yield await readEntry(directory, id, homeDir);
    }
  }
}

/** Entry directory names, newest first. Names the store did not write are ignored. */
export async function entryNames(root: string): Promise<readonly string[]> {
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
  // The name is a zero-padded timestamp with a zero-padded tiebreaker, so it sorts chronologically.
  return names
    .filter((name) => ENTRY_NAME.test(name))
    .sort()
    .reverse();
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

async function readEntry(directory: string, id: string, homeDir: string): Promise<JournalEntry> {
  const path = join(directory, MANIFEST_NAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      id,
      kind: "unreadable",
      reason: `missing a readable manifest: ${errorMessage(error)}`,
    };
  }

  let manifest: JournalManifest;
  try {
    manifest = parseManifest(text, path);
  } catch (error) {
    return { id, kind: "unreadable", reason: errorMessage(error) };
  }

  const [manifestHomeDir, requestedHomeDir] = await Promise.all([
    canonicalPath(manifest.homeDir),
    canonicalPath(homeDir),
  ]);
  if (manifest.id !== id || manifestHomeDir !== requestedHomeDir) {
    return { id, kind: "unreadable", reason: "recorded with an identity that is not its own" };
  }
  return { handle: { directory, manifest }, id, kind: "readable" };
}

/** Treats two filesystem spellings of the same home directory as one journal identity. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
