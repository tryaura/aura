import { isAbsolute, join } from "node:path";

import type { AdapterDetection } from "./adapter.js";
import type { Environment, ExecResult } from "./environment.js";

const VERSION_PATTERN = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u;

const PROBE_TIMEOUT_MS = 5_000;

/** How {@link detectExecutable} identifies one agent application on the search path. */
export interface DetectExecutableOptions {
  /**
   * Arguments whose exit code reports authentication state: `0` is authenticated, `1` is not, and
   * anything else leaves {@link AdapterDetection.authenticated} unset. Omitted when the
   * application exposes no such command, in which case nothing runs after `--version`.
   */
  readonly authenticationArgs?: readonly string[];
  /** Executable name without extension; `.exe` is appended on Windows. */
  readonly binaryName: string;
  /**
   * Full executable name to probe on Windows, replacing the default `.exe`.
   *
   * A Windows CLI is routinely a `.cmd` shim rather than an `.exe` — Cursor's search-path entry
   * is `cursor.cmd`, with no `cursor.exe` beside it.
   */
  readonly windowsBinaryName?: string;
}

/**
 * Walks the search path for an executable that identifies itself as the requested application.
 *
 * A candidate with a parseable version is preferred. The first candidate whose version command
 * exits successfully with unrecognized output is remembered as an installed fallback while the
 * remaining search-path entries are checked for a usable version.
 *
 * The fallback is reported as installed with no version, and no further command runs against it.
 * Aura could not confirm the binary is the requested application, and an unrelated program of the
 * same name on the path should not be handed the authentication arguments of the one it shadows.
 *
 * Duplicate path entries are skipped. Nothing here touches the filesystem: an adapter has no
 * reader, so probing an entry means running it, and running it once each is the floor.
 */
export async function detectExecutable(
  environment: Environment,
  options: DetectExecutableOptions,
): Promise<AdapterDetection> {
  const executableName = executableNameFor(environment, options);
  const probed = new Set<string>();
  let unknownVersionPath: string | undefined;

  for (const pathEntry of environment.pathEntries) {
    if (!isAbsolute(pathEntry) || probed.has(pathEntry)) {
      continue;
    }
    probed.add(pathEntry);

    const executablePath = join(pathEntry, executableName);
    const result = await environment.exec({
      args: ["--version"],
      command: executablePath,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const version = parseVersion(result);

    if (version === undefined) {
      if (result.exitCode === 0 && unknownVersionPath === undefined) {
        unknownVersionPath = executablePath;
      }
      continue;
    }

    return installedDetection(environment, executablePath, options.authenticationArgs, version);
  }

  if (unknownVersionPath !== undefined) {
    return { executablePath: unknownVersionPath, installed: true };
  }

  return { installed: false };
}

function executableNameFor(environment: Environment, options: DetectExecutableOptions): string {
  if (environment.platform !== "win32") {
    return options.binaryName;
  }
  return options.windowsBinaryName ?? `${options.binaryName}.exe`;
}

async function installedDetection(
  environment: Environment,
  executablePath: string,
  authenticationArgs: readonly string[] | undefined,
  version: string,
): Promise<AdapterDetection> {
  const authenticated = await probeAuthentication(environment, executablePath, authenticationArgs);
  return {
    executablePath,
    installed: true,
    version,
    ...(authenticated === undefined ? {} : { authenticated }),
  };
}

async function probeAuthentication(
  environment: Environment,
  executablePath: string,
  authenticationArgs: readonly string[] | undefined,
): Promise<boolean | undefined> {
  if (authenticationArgs === undefined) {
    return undefined;
  }

  const authentication = await environment.exec({
    args: authenticationArgs,
    command: executablePath,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return authenticationStatus(authentication.exitCode);
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
