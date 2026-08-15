import { join, resolve } from "node:path";

/** Where the durable undo journal lives, relative to the home directory. */
const BACKUP_DIRECTORY = join("agents", ".backups");

export const MANIFEST_NAME = "manifest.json";

/**
 * How many journal entries the store keeps.
 *
 * Every entry retains the previous *and* replacement contents of everything its plan touched, so
 * without a ceiling the store grows for the life of the install. Staging a new entry drops the
 * oldest ones past this count.
 */
export const MAX_JOURNAL_ENTRIES = 20;

/** Matches an entry directory, so a foreign name in the store is never read or pruned as one. */
export const ENTRY_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{4})?$/u;

export function backupRoot(homeDir: string): string {
  return resolve(homeDir, BACKUP_DIRECTORY);
}
