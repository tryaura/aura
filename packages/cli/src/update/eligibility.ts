import { lstat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

import { isTerminal } from "../command-support.js";
import { isInstallableVersion, releaseTarget } from "./target.js";
import type { UpdateTarget } from "./types.js";

/** Values that turn startup updates off, matching how `AURA_TELEMETRY=off` reads today. */
const DISABLED_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Everything the gate needs, so nothing below it reads the process or the filesystem to decide. */
export interface EligibilityRequest {
  readonly argv: readonly string[];
  readonly current: Pick<NodeJS.Process, "arch" | "execPath" | "platform">;
  readonly disableEnvironmentVariable: string;
  readonly environmentVariables: Readonly<Record<string, string | undefined>>;
  readonly stderr: Writable;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly version: string | undefined;
}

/** An installation the updater may replace, with the release target already resolved. */
export interface EligibleInstallation {
  readonly executablePath: string;
  readonly target: UpdateTarget;
  readonly version: string;
}

/**
 * Why a run may not install over its own executable.
 *
 * Named rather than collapsed into absence. A user never sees these — every one of them is a
 * silent, correct refusal — but a distribution author wiring up {@link CliUpdates} and getting
 * nothing has no other way to learn which of nine clauses fired.
 */
export type EligibilityRefusal =
  | "continuous-integration"
  | "disabled"
  | "informational-run"
  | "not-a-regular-file"
  | "not-a-terminal"
  | "unstamped-version"
  | "unsupported-target";

export type EligibilityVerdict =
  | { readonly installation: EligibleInstallation; readonly kind: "eligible" }
  | { readonly kind: "refused"; readonly reason: EligibilityRefusal };

/**
 * Whether this run may install over its own executable.
 *
 * Every clause is a refusal, and the whole gate resolves before a single byte is requested: a run
 * that is not eligible makes no network request and touches no file. The interactive and `CI`
 * clauses are what keep a pipeline pinned to the binary it selected — a script that pinned
 * `v0.5.0` must still be running `0.5.0` an hour later.
 */
export async function eligibleInstallation(
  request: EligibilityRequest,
): Promise<EligibilityVerdict> {
  const { current, version } = request;
  if (version === undefined || !isInstallableVersion(version)) {
    return { kind: "refused", reason: "unstamped-version" };
  }
  const target = releaseTarget(current);
  if (target === undefined) {
    return { kind: "refused", reason: "unsupported-target" };
  }
  const blocked = blockedBy(request);
  if (blocked !== undefined) {
    return { kind: "refused", reason: blocked };
  }
  if (!(await isReplaceableFile(current.execPath))) {
    return { kind: "refused", reason: "not-a-regular-file" };
  }
  return {
    installation: { executablePath: current.execPath, target, version },
    kind: "eligible",
  };
}

/** The environment and terminal half of the gate, separated so its clauses stay readable. */
function blockedBy(request: EligibilityRequest): EligibilityRefusal | undefined {
  if (isInformationalRun(request.argv)) {
    return "informational-run";
  }
  if (turnedOff(request)) {
    return "disabled";
  }
  if (inContinuousIntegration(request)) {
    return "continuous-integration";
  }
  return ownsTerminal(request) ? undefined : "not-a-terminal";
}

/** Explicit help and version output must remain immediate. */
function isInformationalRun(argv: readonly string[]): boolean {
  return argv.some((value) => value === "--help" || value === "-h" || value === "--version");
}

function turnedOff(request: EligibilityRequest): boolean {
  const value = request.environmentVariables[request.disableEnvironmentVariable];
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
