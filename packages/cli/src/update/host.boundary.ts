import { execFile } from "node:child_process";
import process from "node:process";

import { VERSION_PROBE_TIMEOUT_MS } from "./limits.js";
import { createUpdateDownload } from "./download.boundary.js";
import type { UpdateHost } from "./host.js";

/** A version line and nothing else: one canonical-shaped version on one line. */
const VERSION_LINE = /^[0-9][0-9A-Za-z.+-]*$/u;

/**
 * The process seam the updater runs against.
 *
 * Named as a boundary because it is one: the process id, the ability to signal another process,
 * and forking a child are ambient state everywhere else in the CLI is forbidden from reading.
 * Everything below this file takes {@link UpdateHost} as a parameter, so the exception is one
 * module wide.
 */
export const UPDATE_HOST: UpdateHost = {
  download: createUpdateDownload(),
  isProcessAlive,
  pid: process.pid,
  probeVersion,
};

/**
 * Whether a process id is still running, from the perspective of this user.
 *
 * Signal `0` performs the permission and existence checks without delivering anything. `EPERM`
 * means the process exists and belongs to someone else, which still counts as alive: the lock it
 * holds is not this run's to break.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Asks an executable what version it is.
 *
 * The child's environment is exactly what the caller passed, which is how a staged binary is
 * verified without giving it the chance to start an update of its own. Any outcome that is not one
 * well-formed version line reads as unknown, and an unknown version never satisfies the equality
 * the installer requires before it replaces anything.
 */
function probeVersion(
  executablePath: string,
  environmentVariables: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      ["--version"],
      {
        encoding: "utf8",
        env: { ...environmentVariables },
        timeout: VERSION_PROBE_TIMEOUT_MS,
      },
      (error, stdout) => {
        const version = stdout.trim();
        resolve(error === null && VERSION_LINE.test(version) ? version : undefined);
      },
    );
  });
}
