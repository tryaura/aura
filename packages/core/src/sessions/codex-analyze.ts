import type { FileReader } from "../workspace/reader.js";
import { createLimiter } from "../workspace/concurrency.js";
import { discoverCodexSessions } from "./codex-discover.js";
import { parseCodexSession, parseCodexSessionLines } from "./codex-parse.js";
import type { CodexTranscriptReader } from "./codex-transcript-reader.js";
import { utcDayKey } from "./iso-time.js";
import { resolveProjects } from "./project-resolve.js";
import type { SessionDetailLevel } from "./session-detail-metrics.js";
import type { AgentSessionMetrics, SessionAnalysis } from "./session-metrics.js";
import { aggregateSessionsByRepo } from "./session-aggregate.js";
import { aggregateWorkItems } from "./work-item-aggregate.js";

/** What one Codex session analysis runs against. */
export interface CodexAnalysisOptions {
  /** How many days back from `now` the window opens, in whole days. */
  readonly days: number;
  /** Whether to retain one row per tool call on each session. Defaults to summary-only. */
  readonly detail?: SessionDetailLevel | undefined;
  readonly homeDir: string;
  /** The run's clock, injected so the window is testable and deterministic. */
  readonly now: Date;
  readonly reader: FileReader;
  /** Optional streaming boundary; the generic file reader remains the embeddable fallback. */
  readonly transcriptReader?: CodexTranscriptReader | undefined;
}

const MS_PER_DAY = 86_400_000;

/**
 * The largest transcript prefix parsed, larger than the general file cap on purpose.
 *
 * A rollout logs every tool output and reasoning trace, so a long session routinely dwarfs any
 * instruction file Aura reads elsewhere; this bound covers all but the most extreme sessions
 * while still keeping one runaway file from exhausting memory.
 */
const MAX_TRANSCRIPT_BYTES = 30_000_000;

/** Bounds open transcript streams while still overlapping filesystem latency. */
const MAX_CONCURRENT_SESSION_READS = 4;

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

  const limit = createLimiter(MAX_CONCURRENT_SESSION_READS);
  const detail = options.detail ?? "summary";
  const parsed = await Promise.all(
    files.map((file) =>
      limit(() => readSession(options.reader, options.transcriptReader, file, detail)),
    ),
  );
  const sessions = parsed.filter(
    (session): session is AgentSessionMetrics => session !== undefined,
  );
  const unreadableFiles = parsed.length - sessions.length;

  const directories = sessions.flatMap((session) =>
    session.cwd === undefined ? [] : [session.cwd],
  );
  const projectLabels = await resolveProjects(options.reader, directories);

  return {
    repos: aggregateSessionsByRepo(sessions, projectLabels),
    scannedFiles: files.length,
    sessions,
    since,
    sources: ["codex"],
    unreadableFiles,
    workItems: aggregateWorkItems(sessions),
  };
}

async function readSession(
  reader: FileReader,
  transcriptReader: CodexTranscriptReader | undefined,
  file: string,
  detail: SessionDetailLevel,
): Promise<AgentSessionMetrics | undefined> {
  if (transcriptReader !== undefined) {
    const transcript = await transcriptReader(file, MAX_TRANSCRIPT_BYTES);
    if (transcript === undefined) {
      return undefined;
    }
    const truncated = transcript.size > MAX_TRANSCRIPT_BYTES;
    const session = await parseCodexSessionLines(transcript.lines, truncated, detail);
    return session === undefined ? undefined : { ...session, transcriptPath: file };
  }
  const contents = await reader.read(file, { maxBytes: MAX_TRANSCRIPT_BYTES });
  if (contents.content === undefined) {
    return undefined;
  }
  const truncated = contents.size !== undefined && contents.size > MAX_TRANSCRIPT_BYTES;
  const session = parseCodexSession(contents.content, truncated, detail);
  return session === undefined ? undefined : { ...session, transcriptPath: file };
}
