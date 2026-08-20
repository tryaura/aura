/**
 * Display width of text, in terminal columns.
 *
 * Text reaches the CLI from plugins — app display names, snippet titles, file paths, table cells —
 * so it can carry East Asian or emoji characters that occupy two columns. Counting code points
 * would under-report those: the tab bar would pick a degradation mode that still overflows, the
 * repaint erasure would land short, and table columns would misalign. One `string-width` wrapper
 * serves every measurement so no two renderers can disagree about how wide a label is; ANSI escape
 * sequences count zero columns, combining marks zero, wide/fullwidth and emoji two.
 */

import stringWidth from "string-width";

import { GRAPHEME_SEGMENTER, safe, safeMultiline } from "./safe-text.js";

export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** Sanitizes a preview body and hard-wraps it, so one entry here is exactly one terminal row. */
export function wrapPreviewLines(content: string, columns: number): readonly string[] {
  return safeMultiline(content)
    .split("\n")
    .flatMap((line) => wrapLine(line, columns));
}

/**
 * Wraps prose at word boundaries, so a report line breaks where a reader would break it.
 *
 * File previews wrap hard because every column of a quoted line is content; a finding's message is
 * a sentence, and breaking `credential` across two rows costs more legibility than the ragged right
 * edge saves. A single word too wide for the column still has to break somewhere, and there it
 * falls back to the same grapheme-accurate hard wrap — a 90-character path cannot be worded around.
 */
export function wrapWords(text: string, columns: number): readonly string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of safe(text).split(" ")) {
    if (word === "") {
      continue;
    }
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= columns) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
    }
    const hard = wrapLine(word, columns);
    lines.push(...hard.slice(0, -1));
    current = hard.at(-1) ?? "";
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/**
 * Hard-wraps one line, advancing by grapheme cluster rather than code point.
 *
 * Width is only meaningful for whole clusters: an emoji written as a base plus a skin-tone
 * modifier, or a flag written as two regional indicators, occupies two columns as a unit but
 * measures two columns *per code point* once split apart. Summing per code point would therefore
 * over-count — a 99-column line would break at 68 — and would contradict the whole-string
 * measurement the fast path below uses on the very same text. A cluster is also the smallest thing
 * a terminal will not split, so it is the only break that renders as intended.
 */
function wrapLine(line: string, columns: number): readonly string[] {
  if (displayWidth(line) <= columns) {
    return [line];
  }
  const wrapped: string[] = [];
  let current = "";
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    const segmentColumns = displayWidth(segment);
    if (width + segmentColumns > columns && current !== "") {
      wrapped.push(current);
      current = "";
      width = 0;
    }
    current += segment;
    width += segmentColumns;
  }
  if (current !== "") {
    wrapped.push(current);
  }
  return wrapped;
}
