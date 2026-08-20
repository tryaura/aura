import type { Writable } from "node:stream";

import { displayWidth } from "./text-width.js";

/** Columns assumed when the stream cannot report a width of its own. */
export const DEFAULT_FRAME_COLUMNS = 80;

/**
 * Moves the cursor back over a painted frame and clears everything below it.
 *
 * Every repainting surface erases through here — the wizard's forms, its loading frames, and the
 * check scan's progress rows — so one escape sequence backs all of them and a frame one surface
 * painted is one another can take away.
 */
export function eraseFrame(lines: number): string {
  return lines > 0 ? `\u001b[${String(lines)}A\r\u001b[0J` : "";
}

/** Counts wrapped terminal rows so a repaint erases the whole previous frame. */
export function countFrameRows(frame: string, columns: number): number {
  let count = 0;
  for (const line of frame.split("\n").slice(0, -1)) {
    count += Math.max(1, Math.ceil(displayWidth(line) / columns));
  }
  return count;
}

/** One positive-integer terminal dimension, or `undefined` when the stream does not report it. */
export function terminalDimension(stdout: Writable, field: "columns" | "rows"): number | undefined {
  if (field === "columns") {
    return positiveInteger("columns" in stdout ? stdout.columns : undefined);
  }
  return positiveInteger("rows" in stdout ? stdout.rows : undefined);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
