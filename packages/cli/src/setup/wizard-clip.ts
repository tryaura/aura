import type { Style } from "../style.js";
import { displayWidth } from "../text-width.js";

/**
 * Windows a frame body to `capacity` display rows, keeping the focused line visible with `more`
 * markers.
 *
 * Rows, not lines: an option label wider than the terminal wraps onto multiple rows, and a window
 * counted in logical lines would still overflow the viewport and break the engine's cursor-up
 * erasure. Each line is measured in the rows it will actually occupy, and the window grows around
 * the focused line only while the measured rows fit.
 */
export function clipBody(
  lines: readonly string[],
  focus: number,
  capacity: number,
  style: Style,
  columns: number,
  pinnedLines: number = 0,
): readonly string[] {
  const spans = lines.map((line) => Math.max(1, Math.ceil(displayWidth(line) / columns)));
  const room = Math.max(1, capacity);
  if (spans.reduce((total, span) => total + span, 0) <= room) {
    return lines;
  }
  const pinnedEnd = Math.min(Math.max(0, pinnedLines), lines.length);
  const pinnedRows = spans.slice(0, pinnedEnd).reduce((total, span) => total + span, 0);
  // A very short terminal still prioritizes the focused row over chrome that cannot fit beside it.
  // At ordinary sizes, only the option rows move while the question context stays anchored.
  if (pinnedEnd > 0 && pinnedRows < room) {
    return [
      ...lines.slice(0, pinnedEnd),
      ...clipWindow(
        lines.slice(pinnedEnd),
        spans.slice(pinnedEnd),
        focus - pinnedEnd,
        room - pinnedRows,
        style,
      ),
    ];
  }
  return clipWindow(lines, spans, focus, room, style);
}

function clipWindow(
  lines: readonly string[],
  spans: readonly number[],
  focus: number,
  room: number,
  style: Style,
): readonly string[] {
  // Two rows are reserved for the markers, so the window never grows past the capacity.
  const window = growWindow(spans, focus, Math.max(1, room - 2));
  const below = lines.length - window.end;
  return [
    ...(window.start > 0 ? [style.dim(`   ↑ ${String(window.start)} more`)] : []),
    ...lines.slice(window.start, window.end),
    ...(below > 0 ? [style.dim(`   ↓ ${String(below)} more`)] : []),
  ];
}

/** Grows `[start, end)` around `focus`, one line below then one above, while `budget` rows allow. */
function growWindow(
  spans: readonly number[],
  focus: number,
  budget: number,
): { readonly end: number; readonly start: number } {
  let start = Math.min(focus, Math.max(0, spans.length - 1));
  let end = start + 1;
  let used = spans[start] ?? 1;
  let extended = true;
  while (extended) {
    extended = false;
    const belowSpan = spans[end];
    if (belowSpan !== undefined && used + belowSpan <= budget) {
      used += belowSpan;
      end += 1;
      extended = true;
    }
    const aboveSpan = start > 0 ? spans[start - 1] : undefined;
    if (aboveSpan !== undefined && used + aboveSpan <= budget) {
      used += aboveSpan;
      start -= 1;
      extended = true;
    }
  }
  return { end, start };
}
