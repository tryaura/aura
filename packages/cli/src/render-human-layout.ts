import type { Writable } from "node:stream";

import { DEFAULT_FRAME_COLUMNS, terminalDimension } from "./terminal-frame.js";
import { displayWidth, wrapWords } from "./text-width.js";

/**
 * The bounds the report lays itself out within.
 *
 * The floor is the width below which no alignment survives — a subject heading and its counts stop
 * fitting on one line at all. The ceiling exists because a right-aligned column drifting a hundred
 * columns from the text it belongs to has stopped being scannable: past that, the eye tracks two
 * unrelated lists rather than one row.
 */
const MIN_REPORT_COLUMNS = 40;
const MAX_REPORT_COLUMNS = 100;
/** Blank columns kept between a row's text and the value pinned to the right edge. */
const PIN_GAP = 2;
/** Below this, a row's text has too little room left to read, so its pinned value takes its own line. */
const MIN_PINNED_TEXT = 16;

/**
 * The width to render one report against.
 *
 * A stream that reports no width of its own — a pipe, a file, a captured test stream — takes the
 * same default the scan frame assumes, so redirected output stays byte-identical with or without a
 * terminal attached. Only an attached terminal can move it, and only within the bounds above.
 */
export function reportColumns(stdout: Writable): number {
  const reported = terminalDimension(stdout, "columns") ?? DEFAULT_FRAME_COLUMNS;
  return Math.min(MAX_REPORT_COLUMNS, Math.max(MIN_REPORT_COLUMNS, reported));
}

export interface PinnedRowOptions {
  /** Indent for wrapped rows after the first. Defaults to {@link PinnedRowOptions.indent}. */
  readonly continuationIndent?: string | undefined;
  /** Applied to each line after wrapping, so styling can never disturb a width measurement. */
  readonly decorate?: ((line: string) => string) | undefined;
  readonly indent: string;
  /** Pre-styled and never wrapped; ANSI sequences measure zero columns, so it aligns as written. */
  readonly pinned?: string | undefined;
  readonly text: string;
  readonly width: number;
}

/**
 * One logical row: indented text that may wrap, with an optional value held at the right edge.
 *
 * The pinned value stays on the first row and the text wraps beneath it rather than truncating,
 * because a finding's message carries up to 500 characters of what was found and a report that
 * dropped the tail would be hiding evidence to keep a column straight. Wrapping applies to every
 * row at one width so the block reads as a rectangle instead of stepping out under the pin.
 */
export function pinnedRow(options: PinnedRowOptions): readonly string[] {
  const decorate = options.decorate ?? ((line: string) => line);
  const continuationIndent = options.continuationIndent ?? options.indent;
  const indentWidth = Math.max(displayWidth(options.indent), displayWidth(continuationIndent));
  const pinnedWidth = options.pinned === undefined ? 0 : displayWidth(options.pinned) + PIN_GAP;
  const textWidth = options.width - indentWidth - pinnedWidth;

  // A label long enough to crowd out its own text keeps the text and gives up the alignment: the
  // pinned value is secondary metadata, and squeezing the row to four columns to hold it straight
  // would cost more than the column is worth.
  if (options.pinned !== undefined && textWidth < MIN_PINNED_TEXT) {
    const { pinned, ...unpinned } = options;
    return [...pinnedRow(unpinned), rightAligned(pinned, options.width)];
  }

  const lines = wrapWords(options.text, Math.max(MIN_PINNED_TEXT, textWidth));
  return lines.map((line, index) => {
    const prefix = index === 0 ? options.indent : continuationIndent;
    const row = `${prefix}${decorate(line)}`;
    if (index > 0 || options.pinned === undefined) {
      return row;
    }
    const used = displayWidth(prefix) + displayWidth(line);
    return `${row}${pinGap(used, options.pinned, options.width)}${options.pinned}`;
  });
}

/** Right-aligns a pre-styled value against the report's edge. */
export function rightAligned(text: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - displayWidth(text)))}${text}`;
}

function pinGap(used: number, pinned: string, width: number): string {
  return " ".repeat(Math.max(PIN_GAP, width - used - displayWidth(pinned)));
}
