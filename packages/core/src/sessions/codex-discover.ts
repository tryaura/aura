import { join } from "node:path";

import type { FileReader } from "../workspace/reader.js";

/**
 * Finds Codex rollout transcripts recorded on or after a given day.
 *
 * Codex writes one JSONL file per session under `~/.codex/sessions/YYYY/MM/DD/`. The date lives
 * in the directory names, so the walk prunes whole years, months, and days lexically against the
 * `YYYY-MM-DD` cutoff without opening a single file. A missing root or an unreadable directory
 * yields no paths: absence of transcripts is a normal state, not a failure.
 */

const YEAR = /^\d{4}$/u;
const MONTH_OR_DAY = /^\d{2}$/u;

/** Absolute transcript paths in the window, sorted for deterministic processing order. */
export async function discoverCodexSessions(
  reader: FileReader,
  homeDir: string,
  sinceDayKey: string,
): Promise<readonly string[]> {
  const root = join(homeDir, ".codex", "sessions");
  const files: string[] = [];
  for (const dayDirectory of await windowDayDirectories(reader, root, sinceDayKey)) {
    const contents = await reader.read(dayDirectory);
    for (const name of contents.entries ?? []) {
      if (name.endsWith(".jsonl")) {
        files.push(join(dayDirectory, name));
      }
    }
  }
  return files.sort();
}

/**
 * Every `root/YYYY/MM/DD` directory whose newest possible day is inside the window.
 *
 * A year is kept when its `-12-31` still reaches the cutoff, a month when its `-31` does, so a
 * level is descended only when something below it can matter. Days compare exactly.
 */
async function windowDayDirectories(
  reader: FileReader,
  root: string,
  sinceDayKey: string,
): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const year of await kept(reader, root, YEAR, (name) => `${name}-12-31`, sinceDayKey)) {
    const months = await kept(
      reader,
      join(root, year),
      MONTH_OR_DAY,
      (name) => `${year}-${name}-31`,
      sinceDayKey,
    );
    for (const month of months) {
      const days = await kept(
        reader,
        join(root, year, month),
        MONTH_OR_DAY,
        (name) => `${year}-${month}-${name}`,
        sinceDayKey,
      );
      for (const day of days) {
        directories.push(join(root, year, month, day));
      }
    }
  }
  return directories;
}

/** Child directory names matching the level's pattern whose newest day reaches the cutoff. */
async function kept(
  reader: FileReader,
  directory: string,
  pattern: RegExp,
  newestDayKey: (name: string) => string,
  sinceDayKey: string,
): Promise<readonly string[]> {
  const contents = await reader.read(directory);
  if (!contents.isDirectory) {
    return [];
  }
  return (contents.entries ?? []).filter(
    (name) => pattern.test(name) && newestDayKey(name) >= sinceDayKey,
  );
}
