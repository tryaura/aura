import type { Writable } from "node:stream";

import { isTerminal } from "../command-support.js";
import {
  countFrameRows,
  DEFAULT_FRAME_COLUMNS,
  eraseFrame,
  terminalDimension,
} from "../terminal-frame.js";

/**
 * The updater's two diagnostic surfaces: a trace for whoever wired the distribution up, and a
 * progress line for whoever is waiting on the download.
 *
 * Neither belongs to the message contract in `docs/cli-ux.md`. The trace stays off unless a
 * variable asks for it, and the progress line is painted only on a terminal that can erase it
 * again — so redirected output, piped output, and `--json` stay byte-identical either way.
 */

/** Suffix on a distribution's disable variable, which is what names its debug variable. */
const DEBUG_SUFFIX = "_DEBUG";

const ENABLED_VALUES: ReadonlySet<string> = new Set(["1", "on", "true", "yes"]);

/** What the progress frame says while the archive streams. */
const DOWNLOAD_PROMPT = "Downloading…";

/** Writes one trace line, or discards it. */
export type UpdateDebug = (message: string) => void;

/** The distribution-specific variable that disables startup updates. */
export function updateEnvironmentVariable(command: string): string {
  const name = command
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
  return `${name}_UPDATE`;
}

/**
 * The debug writer for one distribution.
 *
 * Derived from the command name rather than configured: `acme-dev` gets `ACME_DEV_UPDATE` and its
 * trace gets `ACME_DEV_UPDATE_DEBUG`, leaving neither as a field a distribution can mistype.
 *
 * It exists because every refusal in this subsystem is deliberately silent. That is right for the
 * user, whose command is the thing they asked about — and useless for the author of a distribution
 * whose updates are simply not happening, with nine gates and no way to tell which one fired.
 */
export function createUpdateDebug(
  disableEnvironmentVariable: string,
  environmentVariables: Readonly<Record<string, string | undefined>>,
  stderr: Writable,
): UpdateDebug {
  const value = environmentVariables[`${disableEnvironmentVariable}${DEBUG_SUFFIX}`];
  if (value === undefined || !ENABLED_VALUES.has(value.trim().toLowerCase())) {
    return () => undefined;
  }
  return (message) => {
    stderr.write(`update: ${message}\n`);
  };
}

/** A repainting progress line: {@link report} advances it, {@link close} takes it off the screen. */
export interface UpdateProgress {
  /** Erases the frame. Idempotent, so a `finally` can always call it. */
  readonly close: () => void;
  /** The download callback, or `undefined` when there is nowhere to paint. */
  readonly report: ((received: number, total: number) => void) | undefined;
}

/** What a run with nowhere to paint gets instead. */
const IDLE: UpdateProgress = { close: () => {}, report: undefined };

/**
 * Paints how much of the release archive has arrived.
 *
 * The download is the one part of an update the user waits on, and the archive is tens of
 * megabytes: on a thin connection a single unchanging line is indistinguishable from a hung
 * command. Erased on close, so nothing it painted survives into the outcome line.
 */
export function startUpdateProgress(stderr: Writable): UpdateProgress {
  if (!isTerminal(stderr)) {
    return IDLE;
  }
  let painted = 0;
  let closed = false;

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      stderr.write(eraseFrame(painted));
      painted = 0;
    },
    report: (received, total) => {
      if (closed) {
        return;
      }
      const frame = `  ${DOWNLOAD_PROMPT} ${String(percentage(received, total))}%\n`;
      stderr.write(`${eraseFrame(painted)}${frame}`);
      painted = countFrameRows(
        frame,
        terminalDimension(stderr, "columns") ?? DEFAULT_FRAME_COLUMNS,
      );
    },
  };
}

/** Whole percent, never reaching 100 before the transfer has actually finished. */
function percentage(received: number, total: number): number {
  if (total <= 0) {
    return 99;
  }
  return Math.min(99, Math.floor((received / total) * 100));
}
