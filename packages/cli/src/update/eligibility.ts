import { lstat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { isTerminal } from "../command-support.js";
import { isInstallableVersion, releaseTarget } from "./target.js";
import type { CliStandaloneInstallation, CliUpdateTarget, CliUpdates } from "./types.js";

/** Values that turn startup updates off, matching how `AURA_TELEMETRY=off` reads today. */
const DISABLED_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Everything the gate needs, so nothing below it reads the process or the filesystem to decide. */
export interface EligibilityRequest {
  readonly environmentVariables: Readonly<Record<string, string | undefined>>;
  readonly installation: CliStandaloneInstallation | undefined;
  readonly stderr: Writable;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly updates: CliUpdates | undefined;
  readonly version: string | undefined;
}

/** An installation the updater may replace, with the release target already resolved. */
export interface EligibleInstallation {
  readonly executablePath: string;
  readonly target: CliUpdateTarget;
  readonly updates: CliUpdates;
  readonly version: string;
}

/**
 * Whether this run may install over its own executable.
 *
 * Every clause is a refusal, and the whole gate resolves before a single byte is requested: a run
 * that is not eligible makes no network request and touches no file. The interactive and `CI`
 * clauses are what keep a pipeline pinned to the binary it selected — a script that pinned
 * `v0.4.0` must still be running `0.4.0` an hour later.
 */
export async function eligibleInstallation(
  request: EligibilityRequest,
): Promise<EligibleInstallation | undefined> {
  const { installation, updates, version } = request;
  if (installation === undefined || installation.kind !== "standalone" || updates === undefined) {
    return undefined;
  }
  if (version === undefined || !isInstallableVersion(version)) {
    return undefined;
  }
  const target = releaseTarget(installation);
  if (target === undefined || !updatesAllowed(request)) {
    return undefined;
  }
  if (!(await isReplaceableFile(installation.executablePath))) {
    return undefined;
  }
  return { executablePath: installation.executablePath, target, updates, version };
}

/** The environment and terminal half of the gate, separated so its clauses stay readable. */
function updatesAllowed(request: EligibilityRequest): boolean {
  return !turnedOff(request) && !inContinuousIntegration(request) && ownsTerminal(request);
}

function turnedOff(request: EligibilityRequest): boolean {
  const value = request.environmentVariables[request.updates?.disableEnvironmentVariable ?? ""];
  return value !== undefined && DISABLED_VALUES.has(value.trim().toLowerCase());
}

/**
 * Whether this looks like an automated runner.
 *
 * Any `CI` value counts. Providers disagree on whether it is `true`, `1`, or their own name, and an
 * update nobody asked for is the wrong way to discover which one this runner uses.
 */
function inContinuousIntegration(request: EligibilityRequest): boolean {
  const value = request.environmentVariables["CI"];
  return value !== undefined && value !== "" && value !== "0";
}

/** All three streams, so neither a redirected report nor a piped-in script gets an update. */
function ownsTerminal(request: EligibilityRequest): boolean {
  return isTerminal(request.stdin) && isTerminal(request.stdout) && isTerminal(request.stderr);
}

/**
 * Whether the path is a regular file the installer can rename over.
 *
 * `lstat` rather than `stat`: a symlink means some other installation — a package manager's shim,
 * a version manager's current-release pointer — owns this name, and replacing the link would
 * either detach it from its manager or write through it into a directory Aura does not own.
 */
async function isReplaceableFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
