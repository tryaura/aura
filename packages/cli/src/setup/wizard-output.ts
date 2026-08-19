import type { Writable } from "node:stream";

import { displayWidth } from "../text-width.js";
import { DEFAULT_WIZARD_VIEWPORT, type WizardViewport } from "./wizard-render.js";

export function eraseWizardFrame(lines: number): string {
  return lines > 0 ? `\u001b[${String(lines)}A\r\u001b[0J` : "";
}

/** Counts wrapped terminal rows so a repaint erases the whole previous frame. */
export function countWizardFrameRows(frame: string, columns: number): number {
  let count = 0;
  for (const line of frame.split("\n").slice(0, -1)) {
    count += Math.max(1, Math.ceil(displayWidth(line) / columns));
  }
  return count;
}

export function resolveWizardViewport(stdout: Writable): WizardViewport {
  return {
    columns: terminalSize(stdout, "columns") ?? DEFAULT_WIZARD_VIEWPORT.columns,
    rows: terminalSize(stdout, "rows") ?? DEFAULT_WIZARD_VIEWPORT.rows,
  };
}

function terminalSize(stdout: Writable, field: "columns" | "rows"): number | undefined {
  if (field === "columns") {
    return positiveInteger("columns" in stdout ? stdout.columns : undefined);
  }
  return positiveInteger("rows" in stdout ? stdout.rows : undefined);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
