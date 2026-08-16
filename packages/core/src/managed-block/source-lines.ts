import { detectLineEnding, splitSourceLines, type SourceLine } from "@tryaura/aura-sdk";

/**
 * Line splitting and line-ending detection are shared with plugins that maintain their own managed
 * blocks, so they live in the SDK. Everything below is Markdown-specific and stays here.
 */
export { detectLineEnding, splitSourceLines, type SourceLine };

interface FenceState {
  readonly character: "`" | "~";
  readonly length: number;
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
