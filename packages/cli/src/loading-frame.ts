import { DONE, UNANSWERED } from "./setup/wizard-tabs.js";
import type { Style } from "./style.js";

/** Spinner cadence; fast enough to read as motion, slow enough not to churn the terminal. */
export const SPINNER_INTERVAL_MS = 80;

const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

/** Whether one awaited item has not started yet, is running, or has settled. */
export type LoadingStatus = "pending" | "active" | "complete";

/** What a live surface is told about one item it is waiting on. Never `"pending"`: that is a start state. */
export type LoadingUpdate = (id: string, status: Exclude<LoadingStatus, "pending">) => void;

/**
 * The glyph for one row of any surface that waits on itemized work.
 *
 * Shared by the setup wizard's loading frames and the check scan's progress rows so that one wait
 * cannot look like a different kind of wait than another; the glyph vocabulary in docs/cli-ux.md
 * is one vocabulary.
 */
export function loadingGlyph(status: LoadingStatus, frame: number, style: Style): string {
  if (status === "complete") {
    return DONE;
  }
  if (status === "pending") {
    return style.dim(UNANSWERED);
  }
  return SPINNER[frame % SPINNER.length] ?? SPINNER[0] ?? "…";
}
