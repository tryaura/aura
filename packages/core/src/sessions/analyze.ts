import { createLimiter } from "../workspace/concurrency.js";
import {
  finishAnalysis,
  MAX_CONCURRENT_SESSION_READS,
  sinceDayKey,
  type SessionAnalysisOptions,
  type SessionCollection,
} from "./analyze-finish.js";
import { collectClaudeSessions } from "./claude-analyze.js";
import { collectCodexSessions } from "./codex-analyze.js";
import type { SessionSource } from "./session-detail-metrics.js";
import type { SessionAnalysis } from "./session-metrics.js";

/** The combined analysis reads every supported source unless the caller narrows it. */
export interface AgentSessionsOptions extends SessionAnalysisOptions {
  /** Which transcript sources to read. Defaults to all of them. */
  readonly sources?: readonly SessionSource[] | undefined;
}

const ALL_SOURCES: readonly SessionSource[] = ["claude-code", "codex"];

/**
 * Reads every transcript in the window across the selected sources and sums one analysis.
 *
 * The sources share one read limiter and one byte cap, so the concurrency contract holds for the
 * whole run, not per source. `sources` on the result names what was scanned for — deterministic
 * for a given invocation — not which sources happened to have transcripts on disk.
 */
export async function analyzeAgentSessions(
  options: AgentSessionsOptions,
): Promise<SessionAnalysis> {
  const sources = [...new Set(options.sources ?? ALL_SOURCES)].sort();
  const since = sinceDayKey(options.now, options.days);
  const limit = createLimiter(MAX_CONCURRENT_SESSION_READS);
  const collections = await Promise.all(
    sources.map((source): Promise<SessionCollection> => {
      return source === "codex"
        ? collectCodexSessions(options, since, limit)
        : collectClaudeSessions(options, since, limit);
    }),
  );
  return finishAnalysis(
    options.reader,
    collections.flatMap((collection) => collection.parsed),
    collections.reduce((total, collection) => total + collection.scannedFiles, 0),
    since,
    sources,
  );
}
