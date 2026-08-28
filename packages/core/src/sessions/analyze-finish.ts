import type { FileReader } from "../workspace/reader.js";
import { utcDayKey } from "./iso-time.js";
import { repositoryIdentityFromUrl, resolveProjects } from "./project-resolve.js";
import type { SessionDetailLevel, SessionSource } from "./session-detail-metrics.js";
import type { AgentSessionMetrics, SessionAnalysis } from "./session-metrics.js";
import { boundedSum } from "./session-numbers.js";
import { aggregateSessionsByRepo } from "./session-aggregate.js";
import type { TranscriptReader } from "./transcript-reader.js";
import { aggregateWorkItems } from "./work-item-aggregate.js";

/**
 * The source-agnostic half of a session analysis: reading one transcript through an injected
 * parser and folding every source's parsed sessions into one {@link SessionAnalysis}. Each
 * source module owns only discovery and parsing; everything downstream of the parse is shared.
 */

export type SessionParseResult =
  | { readonly kind: "excluded" }
  | { readonly kind: "session"; readonly session: AgentSessionMetrics }
  | { readonly kind: "unrecognized" };

/** One source's parsed window: every transcript's parse result plus how many files were read. */
export interface SessionCollection {
  readonly parsed: readonly SessionParseResult[];
  readonly scannedFiles: number;
}

/** How one source turns a transcript into a parse result, streaming or from a captured string. */
export interface SessionParser {
  readonly parseContent: (
    content: string,
    truncated: boolean,
    detail: SessionDetailLevel,
    readError: boolean,
  ) => SessionParseResult;
  readonly parseLines: (
    lines: AsyncIterable<string>,
    truncated: boolean,
    detail: SessionDetailLevel,
    completed?: (() => boolean) | undefined,
  ) => Promise<SessionParseResult>;
}

/** What one session analysis runs against, identical for every source. */
export interface SessionAnalysisOptions {
  /** How many days back from `now` the window opens, in whole days. */
  readonly days: number;
  /** Whether to retain one row per tool call on each session. Defaults to summary-only. */
  readonly detail?: SessionDetailLevel | undefined;
  readonly homeDir: string;
  /** The run's clock, injected so the window is testable and deterministic. */
  readonly now: Date;
  readonly reader: FileReader;
  /** Optional streaming boundary; the generic file reader remains the embeddable fallback. */
  readonly transcriptReader?: TranscriptReader | undefined;
}

const MS_PER_DAY = 86_400_000;

/**
 * The largest transcript prefix parsed, larger than the general file cap on purpose.
 *
 * A transcript logs every tool output and reasoning trace, so a long session routinely dwarfs any
 * instruction file Aura reads elsewhere; this bound covers all but the most extreme sessions
 * while still keeping one runaway file from exhausting memory.
 */
const MAX_TRANSCRIPT_BYTES = 30_000_000;

/** Bounds open transcript streams while still overlapping filesystem latency. */
export const MAX_CONCURRENT_SESSION_READS = 4;

/** The first UTC day inside the analysis window, as a `YYYY-MM-DD` key. */
export function sinceDayKey(now: Date, days: number): string {
  return utcDayKey(now.getTime() - days * MS_PER_DAY);
}

/** Reads one transcript through the streaming boundary when present, else the bounded reader. */
export async function readSessionTranscript(
  options: SessionAnalysisOptions,
  file: string,
  parser: SessionParser,
): Promise<SessionParseResult> {
  const detail = options.detail ?? "summary";
  if (options.transcriptReader !== undefined) {
    const transcript = await options.transcriptReader(file, MAX_TRANSCRIPT_BYTES);
    if (transcript === undefined) {
      return { kind: "unrecognized" };
    }
    const truncated = transcript.size > MAX_TRANSCRIPT_BYTES;
    const result = await parser.parseLines(
      transcript.lines,
      truncated,
      detail,
      transcript.completed,
    );
    return withTranscriptPath(result, file);
  }
  const contents = await options.reader.read(file, { maxBytes: MAX_TRANSCRIPT_BYTES });
  if (contents.content === undefined) {
    return { kind: "unrecognized" };
  }
  const truncated = contents.size !== undefined && contents.size > MAX_TRANSCRIPT_BYTES;
  return withTranscriptPath(
    parser.parseContent(contents.content, truncated, detail, contents.utf8Valid === false),
    file,
  );
}

function withTranscriptPath(result: SessionParseResult, file: string): SessionParseResult {
  if (result.kind !== "session") {
    return result;
  }
  return { kind: "session", session: { ...result.session, transcriptPath: file } };
}

/** Folds every parsed transcript, across sources, into the one analysis consumers read. */
export async function finishAnalysis(
  reader: FileReader,
  parsed: readonly SessionParseResult[],
  scannedFiles: number,
  since: string,
  sources: readonly SessionSource[],
): Promise<SessionAnalysis> {
  const sessions = parsed.flatMap((result) => (result.kind === "session" ? [result.session] : []));
  const unreadableFiles = parsed.filter((result) => result.kind === "unrecognized").length;

  const directories = sessions.flatMap((session) => {
    const recordedIdentity =
      session.git.repositoryUrl === undefined
        ? undefined
        : repositoryIdentityFromUrl(session.git.repositoryUrl);
    return recordedIdentity !== undefined || session.cwd === undefined ? [] : [session.cwd];
  });
  const projectLabels = await resolveProjects(reader, directories);

  return {
    invalidValues: boundedSum(sessions.map((session) => session.invalidValues)),
    malformedLines: boundedSum(sessions.map((session) => session.malformedLines)),
    partialFiles: sessions.filter((session) => session.partial).length,
    readErrorFiles: sessions.filter((session) => session.readError).length,
    repos: aggregateSessionsByRepo(sessions, projectLabels),
    scannedFiles,
    sessions,
    since,
    sources,
    unreadableFiles,
    workItems: aggregateWorkItems(sessions),
  };
}
