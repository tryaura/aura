import { join } from "node:path";

import type { FileReader } from "../workspace/reader.js";
import { createLimiter } from "../workspace/concurrency.js";
import { utcDayKey } from "./iso-time.js";

/**
 * Finds Claude Code transcripts that could hold a session started on or after a given day.
 *
 * Claude Code writes one JSONL file per session under `~/.claude/projects/<encoded-cwd>/`, with
 * no date in the layout, so the window is pruned by file mtime instead: the last write can never
 * precede the session's start, so a file last written before the window holds nothing inside it.
 * Session subdirectories (subagent transcripts, offloaded tool results) are never descended into.
 * A missing root or an unreadable directory yields no paths: absence of transcripts is a normal
 * state, not a failure.
 */

/** Keeps discovery responsive without opening an unbounded number of filesystem operations. */
const MAX_CONCURRENT_DISCOVERY_READS = 24;

/** Absolute transcript paths possibly in the window, sorted for deterministic order. */
export async function discoverClaudeSessions(
  reader: FileReader,
  homeDir: string,
  sinceDayKey: string,
): Promise<readonly string[]> {
  const root = join(homeDir, ".claude", "projects");
  const rootContents = await reader.read(root);
  if (!rootContents.isDirectory) {
    return [];
  }
  const limit = createLimiter(MAX_CONCURRENT_DISCOVERY_READS);
  const candidates = (
    await Promise.all(
      (rootContents.entries ?? []).map((project) =>
        limit(() => projectTranscripts(reader, root, project)),
      ),
    )
  ).flat();
  const inspected = await Promise.all(
    candidates.map((path) =>
      limit(async () => ((await lastWriteReaches(reader, path, sinceDayKey)) ? path : undefined)),
    ),
  );
  return inspected.flatMap((path) => (path === undefined ? [] : [path])).sort();
}

async function projectTranscripts(
  reader: FileReader,
  root: string,
  project: string,
): Promise<readonly string[]> {
  const directory = join(root, project);
  const contents = await reader.read(directory);
  if (!contents.isDirectory) {
    return [];
  }
  return (contents.entries ?? [])
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directory, name));
}

/** Whether the file's last write reaches the window. No answer means the file is kept. */
async function lastWriteReaches(
  reader: FileReader,
  path: string,
  sinceDayKey: string,
): Promise<boolean> {
  const inspect = reader.inspect;
  if (inspect === undefined) {
    return true;
  }
  const contents = await inspect(path);
  if (contents.mtimeMs === undefined) {
    return true;
  }
  return utcDayKey(contents.mtimeMs) >= sinceDayKey;
}
