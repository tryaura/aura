import { createLimiter, type Limiter } from "../workspace/concurrency.js";
import {
  finishAnalysis,
  MAX_CONCURRENT_SESSION_READS,
  readSessionTranscript,
  sinceDayKey,
  type SessionAnalysisOptions,
  type SessionCollection,
  type SessionParser,
} from "./analyze-finish.js";
import { discoverCodexSessions } from "./codex-discover.js";
import { parseCodexSessionLinesResult, parseCodexSessionResult } from "./codex-parse.js";
import type { SessionAnalysis } from "./session-metrics.js";

const CODEX_PARSER: SessionParser = {
  parseContent: parseCodexSessionResult,
  parseLines: parseCodexSessionLinesResult,
};

/** Discovers and parses every Codex rollout in the window; the analysis tail is shared. */
export async function collectCodexSessions(
  options: SessionAnalysisOptions,
  since: string,
  limit: Limiter,
): Promise<SessionCollection> {
  const files = await discoverCodexSessions(options.reader, options.homeDir, since);
  const parsed = await Promise.all(
    files.map((file) => limit(() => readSessionTranscript(options, file, CODEX_PARSER))),
  );
  return { parsed, scannedFiles: files.length };
}

/**
 * Reads every Codex transcript in the window and sums what the sessions did.
 *
 * A transcript larger than the shared byte cap is read up to the cap and marked truncated, so one
 * enormous session slows the analysis instead of sinking it. Files that do not read or do not
 * parse are counted, not reported individually; malformed records, rejected values, and
 * interrupted streams mark recognized sessions partial so the caller can report coverage.
 */
export async function analyzeCodexSessions(
  options: SessionAnalysisOptions,
): Promise<SessionAnalysis> {
  const since = sinceDayKey(options.now, options.days);
  const collection = await collectCodexSessions(
    options,
    since,
    createLimiter(MAX_CONCURRENT_SESSION_READS),
  );
  return finishAnalysis(options.reader, collection.parsed, collection.scannedFiles, since, [
    "codex",
  ]);
}
