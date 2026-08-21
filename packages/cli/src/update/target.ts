import { gt, valid } from "semver";

import type { CliStandaloneInstallation, CliUpdateTarget } from "./types.js";

/**
 * The version a source build reports.
 *
 * Only release CI stamps a real version into the distribution manifest, so a developer running a
 * checkout is structurally indistinguishable from the newest release. Refusing this value keeps a
 * source build from replacing itself with a published binary.
 */
const UNSTAMPED_VERSION = "0.0.0";

const TARGETS: Readonly<Record<string, CliUpdateTarget>> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
};

/** The release target for one installation, or `undefined` when no release names this machine. */
export function releaseTarget(
  installation: CliStandaloneInstallation,
): CliUpdateTarget | undefined {
  return TARGETS[`${installation.platform}-${installation.architecture}`];
}

/**
 * Whether a version is canonical semver a release can be selected by.
 *
 * Canonical rather than merely parseable: `1.4` and `v1.4.0` both describe a release, but only one
 * spelling can be compared against a tag, a probed `--version`, and a cached candidate and agree
 * with itself every time.
 */
export function isInstallableVersion(value: string): boolean {
  return valid(value) === value && value !== UNSTAMPED_VERSION;
}

/** Whether `candidate` is a strictly newer release than `current`. Prereleases order as semver. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return valid(candidate) === candidate && valid(current) === current && gt(candidate, current);
}
