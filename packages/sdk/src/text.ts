/** One line of a source document, with the offsets needed to splice it back in place. */
export interface SourceLine {
  readonly end: number;
  readonly ending: string;
  readonly number: number;
  readonly start: number;
  readonly text: string;
}

/** Splits text without losing offsets or line-ending bytes, one line at a time. */
export function* splitSourceLines(source: string): Generator<SourceLine> {
  let start = 0;
  let number = 1;

  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) {
      yield { end: source.length, ending: "", number, start, text: source.slice(start) };
      return;
    }

    const hasCarriageReturn = newline > start && source[newline - 1] === "\r";
    const textEnd = hasCarriageReturn ? newline - 1 : newline;
    yield {
      end: newline + 1,
      ending: hasCarriageReturn ? "\r\n" : "\n",
      number,
      start,
      text: source.slice(start, textEnd),
    };
    start = newline + 1;
    number += 1;
  }
}

/**
 * Uses the document's first line ending so generated content follows its established convention.
 *
 * Sampling the first ending rather than asking whether the text contains a CRLF anywhere keeps a
 * single stray CRLF in an otherwise LF document from converting everything Aura appends.
 */
export function detectLineEnding(source: string): "\n" | "\r\n" {
  const newline = source.indexOf("\n");
  return newline > 0 && source[newline - 1] === "\r" ? "\r\n" : "\n";
}
