import { isAbsolute, join } from "node:path";

import type { Environment, ExecResult } from "./environment.js";

/** Matches the version an executable prints for `--version`, however it decorates it. */
const VERSION_PATTERN = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u;

const PROBE_TIMEOUT_MS = 5_000;

/** An executable found on the search path together with the version it reported. */
export interface VersionedExecutable {
  /** Absolute path to the executable that responded. */
  readonly executablePath: string;
  /** The version it printed for `--version`. */
  readonly version: string;
}

/**
 * Walks the search path for an executable that identifies itself with a parseable version.
 *
 * A candidate is accepted only once `--version` reports a version this can parse. Treating any
 * exit code other than "missing" as success meant an unrelated binary of the same name on the
 * path — or one that hung until the timeout killed it — ended the walk and was reported as an
 * installation.
 *
 * Duplicate and relative path entries are skipped. Nothing here touches the filesystem: an
 * adapter has no reader, so probing an entry means running it, and running it once each is the
 * floor. Callers pick `executableName` per platform — a Windows CLI is often a `.cmd` shim
 * rather than an `.exe`.
 */
export async function findVersionedExecutable(
  environment: Environment,
  executableName: string,
): Promise<VersionedExecutable | undefined> {
  const probed = new Set<string>();

  for (const pathEntry of environment.pathEntries) {
    if (!isAbsolute(pathEntry) || probed.has(pathEntry)) {
      continue;
    }
    probed.add(pathEntry);

    const executablePath = join(pathEntry, executableName);
    const version = parseVersion(
      await environment.exec({
        args: ["--version"],
        command: executablePath,
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    );
    if (version !== undefined) {
      return { executablePath, version };
    }
  }

  return undefined;
}

function parseVersion(result: ExecResult): string | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  return VERSION_PATTERN.exec(result.stdout)?.[1];
}
