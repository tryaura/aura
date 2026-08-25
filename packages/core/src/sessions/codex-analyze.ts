import type { FileReader } from "../workspace/reader.js";
import { discoverCodexSessions } from "./codex-discover.js";
import { parseCodexSession } from "./codex-parse.js";
import { utcDayKey } from "./iso-time.js";
import { resolveProjects } from "./project-resolve.js";
import type { AgentSessionMetrics, SessionAnalysis } from "./session-metrics.js";
import { aggregateSessionsByRepo } from "./session-aggregate.js";

/** What one Codex session analysis runs against. */
export interface CodexAnalysisOptions {
  /** How many days back from `now` the window opens, in whole days. */
  readonly days: number;
  readonly homeDir: string;
  /** The run's clock, injected so the window is testable and deterministic. */
  readonly now: Date;
  readonly reader: FileReader;
}

const MS_PER_DAY = 86_400_000;

/**
 * The largest transcript read whole, larger than the general file cap on purpose.
 *
 * A rollout logs every tool output and reasoning trace, so a long session routinely dwarfs any
 * instruction file Aura reads elsewhere; this bound covers all but the most extreme sessions
 * while still keeping one runaway file from exhausting memory.
 */
const MAX_TRANSCRIPT_BYTES = 30_000_000;

/**
 * Reads every Codex transcript in the window and sums what the sessions did.
 *
 * A transcript larger than {@link MAX_TRANSCRIPT_BYTES} is read up to the cap and marked
 * truncated, so one enormous session slows the analysis instead of sinking it. Files that do not
 * read or do not parse are counted, not reported individually: the caller's report says how much
 * of the window it actually saw.
 */
export async function analyzeCodexSessions(
  options: CodexAnalysisOptions,
): Promise<SessionAnalysis> {
  const since = utcDayKey(options.now.getTime() - options.days * MS_PER_DAY);
  const files = await discoverCodexSessions(options.reader, options.homeDir, since);

  const sessions: AgentSessionMetrics[] = [];
  let unreadableFiles = 0;
  for (const file of files) {
    const session = await readSession(options.reader, file);
    if (session === undefined) {
      unreadableFiles += 1;
    } else {
      sessions.push(session);
    }
  }

  const directories = sessions.flatMap((session) =>
    session.cwd === undefined ? [] : [session.cwd],
  );
  const projectLabels = await resolveProjects(options.reader, directories);

  return {
    repos: aggregateSessionsByRepo(sessions, projectLabels),
    scannedFiles: files.length,
    sessions,
    since,
    unreadableFiles,
  };
}

async function readSession(
  reader: FileReader,
  file: string,
): Promise<AgentSessionMetrics | undefined> {
  const contents = await reader.read(file, { maxBytes: MAX_TRANSCRIPT_BYTES });
  if (contents.content === undefined) {
    return undefined;
  }
  const truncated = contents.size !== undefined && contents.size > MAX_TRANSCRIPT_BYTES;
  const session = parseCodexSession(contents.content, truncated);
  return session === undefined ? undefined : { ...session, transcriptPath: file };
}
