import type { ParseState } from "./session-parse-state.js";
import { parseTranscriptRecord } from "./transcript-json.js";

/**
 * The shared JSONL walk: one line at a time, malformed lines counted, records handed to the
 * source's reader. Both parsers fold the same way; only what a record means differs.
 */

export type TranscriptRecordReader<State extends ParseState> = (
  state: State,
  record: Record<string, unknown>,
  line: number,
) => void;

/** Parses one line at a time without allocating an array proportional to the transcript. */
export function readTranscriptLines<State extends ParseState>(
  state: State,
  content: string,
  truncated: boolean,
  read: TranscriptRecordReader<State>,
): void {
  let lineNumber = 0;
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const finalLine = newline === -1;
    if (finalLine && truncated) {
      return;
    }
    lineNumber += 1;
    const line = content.slice(start, finalLine ? content.length : newline);
    readTranscriptLine(state, line, lineNumber, read);
    if (finalLine) {
      return;
    }
    start = newline + 1;
  }
}

/** The streaming variant of {@link readTranscriptLines}, fed one line at a time. */
export async function readTranscriptLineStream<State extends ParseState>(
  state: State,
  lines: AsyncIterable<string>,
  read: TranscriptRecordReader<State>,
): Promise<void> {
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    readTranscriptLine(state, line, lineNumber, read);
  }
}

function readTranscriptLine<State extends ParseState>(
  state: State,
  line: string,
  lineNumber: number,
  read: TranscriptRecordReader<State>,
): void {
  if (line.trim() === "") {
    return;
  }
  const record = parseTranscriptRecord(line);
  if (record !== undefined) {
    read(state, record, lineNumber);
  } else {
    state.malformedLines += 1;
  }
}
