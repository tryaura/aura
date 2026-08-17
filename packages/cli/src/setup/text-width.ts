/**
 * Approximate display width of text, in terminal columns.
 *
 * Labels reach the wizard from plugins — app display names, snippet titles, file paths — so they
 * can carry East Asian or emoji characters that occupy two columns. Counting code points would
 * under-report those, so the tab bar would pick a degradation mode that still overflows and the
 * repaint erasure would land short. A two-bucket approximation is enough here: combining marks
 * take no column, wide/fullwidth ranges take two, everything else takes one.
 */

import { safeMultiline } from "../safe-text.js";

const ZERO_WIDTH = /\p{M}/u;

/** East Asian Wide/Fullwidth blocks plus the emoji planes, as inclusive code-point ranges. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += characterWidth(character);
  }
  return width;
}

export function characterWidth(character: string): number {
  if (ZERO_WIDTH.test(character)) {
    return 0;
  }
  const code = character.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([start, end]) => code >= start && code <= end) ? 2 : 1;
}

/** Sanitizes a preview body and hard-wraps it, so one entry here is exactly one terminal row. */
export function wrapPreviewLines(content: string, columns: number): readonly string[] {
  return safeMultiline(content)
    .split("\n")
    .flatMap((line) => wrapLine(line, columns));
}

function wrapLine(line: string, columns: number): readonly string[] {
  if (displayWidth(line) <= columns) {
    return [line];
  }
  const wrapped: string[] = [];
  let current = "";
  let width = 0;
  for (const character of line) {
    const characterColumns = characterWidth(character);
    if (width + characterColumns > columns && current !== "") {
      wrapped.push(current);
      current = "";
      width = 0;
    }
    current += character;
    width += characterColumns;
  }
  if (current !== "") {
    wrapped.push(current);
  }
  return wrapped;
}
