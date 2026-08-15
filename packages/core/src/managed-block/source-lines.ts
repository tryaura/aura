export interface SourceLine {
  readonly end: number;
  readonly ending: string;
  readonly number: number;
  readonly start: number;
  readonly text: string;
}

interface FenceState {
  readonly character: "`" | "~";
  readonly length: number;
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

/** Uses the document's first line ending so generated content follows its established convention. */
export function detectLineEnding(source: string): "\n" | "\r\n" {
  const newline = source.indexOf("\n");
  return newline > 0 && source[newline - 1] === "\r" ? "\r\n" : "\n";
}

/** Tracks Markdown fences so marker examples inside code blocks are ordinary text. */
export function advanceFence(
  line: string,
  current: FenceState | undefined,
): FenceState | undefined {
  const run = fenceRun(line);
  if (run === undefined) {
    return current;
  }
  if (current === undefined) {
    return run.length >= 3 ? run : undefined;
  }
  if (
    run.character === current.character &&
    run.length >= current.length &&
    line.slice(run.end).trim().length === 0
  ) {
    return undefined;
  }
  return current;
}

export type MarkdownFence = FenceState;

interface FenceRun extends FenceState {
  readonly end: number;
}

function fenceRun(line: string): FenceRun | undefined {
  let index = 0;
  while (index < 3 && line[index] === " ") {
    index += 1;
  }
  const character = line[index];
  if (character !== "`" && character !== "~") {
    return undefined;
  }
  const start = index;
  while (line[index] === character) {
    index += 1;
  }
  return { character, end: index, length: index - start };
}
