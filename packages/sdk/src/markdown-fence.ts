/** An open fenced code block: its delimiter character and the length of the opening run. */
export interface MarkdownFence {
  readonly character: "`" | "~";
  readonly length: number;
}

/**
 * Advances CommonMark fence state across one line.
 *
 * One tracker for everything that walks Markdown line by line — managed-block parsing in core,
 * code masking here — so two callers cannot disagree about where a fence ends. The load-bearing
 * CommonMark rule is that a closing fence must be *at least as long* as its opener: a block opened
 * with ```` is not closed by ```, and an exact-length comparison silently treats the rest of such
 * a file as code.
 */
export function advanceMarkdownFence(
  line: string,
  current: MarkdownFence | undefined,
): MarkdownFence | undefined {
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

interface FenceRun extends MarkdownFence {
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
