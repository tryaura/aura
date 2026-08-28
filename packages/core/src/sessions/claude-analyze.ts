import { createLimiter, type Limiter } from "../workspace/concurrency.js";
import {
  finishAnalysis,
  MAX_CONCURRENT_SESSION_READS,
  readSessionTranscript,
  sinceDayKey,
  type SessionAnalysisOptions,
  type SessionCollection,
  type SessionParseResult,
  type SessionParser,
} from "./analyze-finish.js";
import { discoverClaudeSessions } from "./claude-discover.js";
import { parseClaudeSessionLinesResult, parseClaudeSessionResult } from "./claude-parse.js";
import { utcDayKey, utcTimestampMs } from "./iso-time.js";
import type { SessionAnalysis } from "./session-metrics.js";

const CLAUDE_PARSER: SessionParser = {
  parseContent: parseClaudeSessionResult,
  parseLines: parseClaudeSessionLinesResult,
};

/**
 * Discovers and parses every Claude Code transcript in the window; the analysis tail is shared.
 *
 * Discovery prunes by file mtime, which admits an old session merely touched inside the window,
 * so a parsed session that started before the window is excluded here — the same "started in the
 * window" semantics the Codex date tree enforces by layout.
 */
export async function collectClaudeSessions(
  options: SessionAnalysisOptions,
  since: string,
  limit: Limiter,
): Promise<SessionCollection> {
  const files = await discoverClaudeSessions(options.reader, options.homeDir, since);
  const parsed = await Promise.all(
    files.map((file) => limit(() => readSessionTranscript(options, file, CLAUDE_PARSER))),
  );
  return {
    parsed: parsed.map((result) => windowFiltered(result, since)),
    scannedFiles: files.length,
  };
}

/** Reads every Claude Code transcript in the window and sums what the sessions did. */
export async function analyzeClaudeSessions(
  options: SessionAnalysisOptions,
): Promise<SessionAnalysis> {
  const since = sinceDayKey(options.now, options.days);
  const collection = await collectClaudeSessions(
    options,
    since,
    createLimiter(MAX_CONCURRENT_SESSION_READS),
  );
  return finishAnalysis(options.reader, collection.parsed, collection.scannedFiles, since, [
    "claude-code",
  ]);
}

function windowFiltered(result: SessionParseResult, since: string): SessionParseResult {
  if (result.kind !== "session" || result.session.startedAt === undefined) {
    return result;
  }
  const startedMs = utcTimestampMs(result.session.startedAt);
  if (startedMs !== undefined && utcDayKey(startedMs) < since) {
    return { kind: "excluded" };
  }
  return result;
}
