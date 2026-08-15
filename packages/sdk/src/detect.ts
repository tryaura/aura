import { isAbsolute, join } from "node:path";

import type { AdapterDetection } from "./adapter.js";
import type { Environment, ExecResult } from "./environment.js";

const VERSION_PATTERN = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u;

const PROBE_TIMEOUT_MS = 5_000;

/** How {@link detectExecutable} identifies one agent application on the search path. */
export interface DetectExecutableOptions {
  /**
   * Arguments whose exit code reports authentication state: `0` is authenticated, `1` is not, and
   * anything else leaves {@link AdapterDetection.authenticated} unset.
   */
  readonly authenticationArgs: readonly string[];
  /** Executable name without extension; `.exe` is appended on Windows. */
  readonly binaryName: string;
}

/**
 * Walks the search path for an executable that identifies itself as the requested application.
 *
 * A candidate is accepted only once `--version` reports a version Aura can parse. Treating any
 * exit code other than "missing" as success meant an unrelated binary of the same name on the
 * path — or one that hung until the timeout killed it — ended the walk and was reported as an
 * installation, with the authentication probe already run against it.
 *
 * Duplicate path entries are skipped. Nothing here touches the filesystem: an adapter has no
 * reader, so probing an entry means running it, and running it once each is the floor.
 */
export async function detectExecutable(
  environment: Environment,
  options: DetectExecutableOptions,
): Promise<AdapterDetection> {
  const executableName =
    environment.platform === "win32" ? `${options.binaryName}.exe` : options.binaryName;
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

    if (version === undefined) {
      continue;
    }

    const authentication = await environment.exec({
      args: options.authenticationArgs,
      command: executablePath,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const authenticated = authenticationStatus(authentication.exitCode);

    return {
      executablePath,
      installed: true,
      version,
      ...(authenticated === undefined ? {} : { authenticated }),
    };
  }

  return { installed: false };
}

function authenticationStatus(exitCode: number): boolean | undefined {
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 1) {
    return false;
  }
  return undefined;
}

function parseVersion(result: ExecResult): string | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  return VERSION_PATTERN.exec(result.stdout)?.[1];
}
