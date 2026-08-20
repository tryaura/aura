import type { Writable } from "node:stream";

import { isTerminal } from "./command-support.js";
import {
  loadingGlyph,
  SPINNER_INTERVAL_MS,
  type LoadingStatus,
  type LoadingUpdate,
} from "./loading-frame.js";
import { safe } from "./safe-text.js";
import { createStyle, type Style } from "./style.js";
import {
  countFrameRows,
  DEFAULT_FRAME_COLUMNS,
  eraseFrame,
  terminalDimension,
} from "./terminal-frame.js";

/** What the frame says while adapters probe the machine. Same sentence the setup wizard uses. */
const SCAN_PROMPT = "Scanning this machine…";

/** One application the scan is waiting on. */
export interface ScanProgressRow {
  readonly id: string;
  readonly label: string;
}

/** A live scan surface: {@link report} feeds it, {@link close} takes it back off the screen. */
export interface ScanProgress {
  /** Erases the frame and stops the animation. Idempotent, so a `finally` can always call it. */
  readonly close: () => void;
  /** Records one adapter's transition. Ignores ids it is not showing, and calls after close. */
  readonly report: LoadingUpdate;
}

/** What a run with nothing to animate, or nowhere to animate it, gets instead. */
const IDLE: ScanProgress = { close: () => {}, report: () => {} };

export interface ScanProgressOptions {
  readonly colorDepth: number;
  /** The applications to list, in the order the scan declared them. Empty disables the surface. */
  readonly rows: readonly ScanProgressRow[];
  readonly stdout: Writable;
}

/**
 * Paints the applications a check run is probing, and keeps painting until the scan settles.
 *
 * A scan is dominated by third-party probes Aura does not control — a companion CLI that connects
 * to every configured MCP server before it answers takes seconds — and a report that arrives all
 * at once at the end cannot distinguish that from a hang. The frame names which application is
 * still being waited on, so the wait is attributable rather than mysterious.
 *
 * Purely a display: it never changes what the scan does, and a run with no terminal to paint on
 * gets {@link IDLE} so redirected output stays byte-identical to what it was before the surface
 * existed. The frame is erased on close, so nothing it painted survives into the report.
 */
export function startScanProgress(options: ScanProgressOptions): ScanProgress {
  if (options.rows.length === 0 || !isTerminal(options.stdout)) {
    return IDLE;
  }

  const style = createStyle(options.colorDepth);
  const statuses = new Map<string, LoadingStatus>(options.rows.map((row) => [row.id, "pending"]));
  let painted = 0;
  let spinnerFrame = 0;
  let closed = false;
  let lastFrame = "";

  const paint = (erase = painted): void => {
    const columns = terminalDimension(options.stdout, "columns") ?? DEFAULT_FRAME_COLUMNS;
    const frame = renderScanFrame(options.rows, statuses, spinnerFrame, style);
    options.stdout.write(`${eraseFrame(erase)}${frame}`);
    lastFrame = frame;
    painted = countFrameRows(frame, columns);
  };
  const onResize = (): void => {
    const columns = terminalDimension(options.stdout, "columns") ?? DEFAULT_FRAME_COLUMNS;
    paint(Math.max(painted, countFrameRows(lastFrame, columns)));
  };

  paint();
  options.stdout.on("resize", onResize);
  const animation = setInterval(() => {
    spinnerFrame += 1;
    paint();
  }, SPINNER_INTERVAL_MS);

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(animation);
      options.stdout.off("resize", onResize);
      options.stdout.write(eraseFrame(painted));
      painted = 0;
    },
    report: (id, status) => {
      if (closed || !statuses.has(id)) {
        return;
      }
      statuses.set(id, status);
      paint();
    },
  };
}

/** One frame: the prompt, then one glyphed row per application, padded away from the report. */
function renderScanFrame(
  rows: readonly ScanProgressRow[],
  statuses: ReadonlyMap<string, LoadingStatus>,
  spinnerFrame: number,
  style: Style,
): string {
  const lines = [
    "",
    ` ${style.bold(SCAN_PROMPT)}`,
    "",
    ...rows.map(
      (row) =>
        `   ${loadingGlyph(statuses.get(row.id) ?? "pending", spinnerFrame, style)} ${safe(row.label)}`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
