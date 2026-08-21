import type { Readable, Writable } from "node:stream";

import { attemptsFor, readUpdateCache, shouldCheck, writeUpdateCache } from "./cache.js";
import { eligibleInstallation, type EligibleInstallation } from "./eligibility.js";
import { installUpdate, type InstallOutcome } from "./install.js";
import { digestRefusedLine, installFailedLine, updatedLine, updatingLine } from "./messages.js";
import {
  resolveUpdateSource,
  sourceIdentity,
  type UpdateHttpGet,
  type UpdateResolution,
} from "./provider.js";
import type { UpdateHost } from "./host.js";
import type { CliBranding } from "../types.js";
import type { CliStandaloneInstallation, CliUpdates } from "./types.js";

/** Everything the startup update reads, injected so a run reads nothing from the process itself. */
export interface StartupUpdateRequest {
  readonly branding: CliBranding;
  readonly environmentVariables: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly host: UpdateHost;
  readonly httpGet: UpdateHttpGet;
  readonly installation: CliStandaloneInstallation | undefined;
  readonly now: () => Date;
  readonly stderr: Writable;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly updates: CliUpdates | undefined;
}

/**
 * Installs a newer release before the requested command runs, or does nothing at all.
 *
 * Nothing here can change what the command does or what it exits with. Every failure path is
 * swallowed: the user asked Aura to check a repository, and an update that could not happen is not
 * a reason to refuse. The successfully updated executable is used by the next invocation — this
 * process keeps running the image it started with.
 */
export async function runStartupUpdate(request: StartupUpdateRequest): Promise<void> {
  try {
    const eligible = await eligibleInstallation({ ...request, version: request.branding.version });
    if (eligible !== undefined) {
      await check(request, eligible);
    }
  } catch {
    // An updater that throws must still leave the command it interrupted able to run.
  }
}

async function check(request: StartupUpdateRequest, eligible: EligibleInstallation): Promise<void> {
  const now = request.now().getTime();
  const identity = sourceIdentity(eligible.updates.source, request.branding.command);
  const entry = await readUpdateCache(request.homeDir, identity, now);
  if (!shouldCheck(entry, now)) {
    return;
  }

  const resolution = await resolveUpdateSource(eligible.updates.source, {
    command: request.branding.command,
    // Revalidation is offered only when the cached answer was "nothing newer". A cached candidate
    // has to be re-resolved in full, because the credential its download needs is deliberately not
    // in the cache and only a fresh document can rebuild it.
    ...(entry?.outcome === "current" && entry.etag !== undefined ? { etag: entry.etag } : {}),
    httpGet: request.httpGet,
    readVariable: (name) => readVariable(request.environmentVariables, name),
    target: eligible.target,
    userAgent: `${request.branding.command}/${eligible.version}`,
    version: eligible.version,
  });

  await apply(request, eligible, identity, now, resolution, entry);
}

async function apply(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  identity: string,
  now: number,
  resolution: UpdateResolution,
  entry: Awaited<ReturnType<typeof readUpdateCache>>,
): Promise<void> {
  if (resolution.kind === "failure") {
    await writeUpdateCache(request.homeDir, identity, { checkedAt: now, outcome: "check-failed" });
    return;
  }
  if (resolution.kind !== "candidate") {
    // An unchanged response carries no entity tag of its own; the cached one still names the
    // representation the server just confirmed, so it survives to the next revalidation.
    const etag = resolution.kind === "current" ? (resolution.etag ?? entry?.etag) : entry?.etag;
    await writeUpdateCache(request.homeDir, identity, {
      checkedAt: now,
      ...(etag === undefined ? {} : { etag }),
      outcome: "current",
    });
    return;
  }

  const { candidate } = resolution;
  request.stderr.write(updatingLine(request.branding, eligible.version, candidate.version));
  const outcome = await installUpdate({
    candidate,
    command: request.branding.command,
    downloadHeaders: resolution.downloadHeaders,
    executablePath: eligible.executablePath,
    host: request.host,
    now,
    probeEnvironment: probeEnvironment(request, eligible.updates),
  });
  report(request, eligible, candidate.version, outcome);
  await record(request, identity, now, resolution, outcome, attemptsFor(entry, candidate.version));
}

/** One line, or none: the outcome table's message column. */
function report(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  version: string,
  outcome: InstallOutcome,
): void {
  if (outcome.kind === "installed") {
    request.stderr.write(updatedLine(request.branding, version));
    return;
  }
  if (outcome.kind === "refused") {
    request.stderr.write(digestRefusedLine(request.branding, version));
    return;
  }
  if (outcome.kind === "failed") {
    const manual = eligible.updates.manualUpdateUrl ?? request.branding.docsUrl;
    request.stderr.write(installFailedLine(request.branding, version, manual));
  }
}

/** Stores what happened, so a release that will not install is not retried on every command. */
function record(
  request: StartupUpdateRequest,
  identity: string,
  now: number,
  resolution: Extract<UpdateResolution, { kind: "candidate" }>,
  outcome: InstallOutcome,
  attempts: number,
): Promise<void> {
  if (outcome.kind === "installed") {
    return writeUpdateCache(request.homeDir, identity, { checkedAt: now, outcome: "current" });
  }
  if (outcome.kind === "skipped") {
    return writeUpdateCache(request.homeDir, identity, { checkedAt: now, outcome: "check-failed" });
  }
  return writeUpdateCache(request.homeDir, identity, {
    candidate: resolution.candidate,
    checkedAt: now,
    ...(resolution.etag === undefined ? {} : { etag: resolution.etag }),
    failedAt: now,
    failedAttempts: attempts + 1,
    outcome: "candidate",
  });
}

/**
 * The environment a version probe runs in.
 *
 * Deliberately tiny, and deliberately carrying this distribution's own disable variable: the
 * installer verifies a staged binary by running it, and a child that started an update of its own
 * would recurse into the directory its parent is mid-transaction on.
 */
function probeEnvironment(
  request: StartupUpdateRequest,
  updates: CliUpdates,
): Record<string, string> {
  const home = request.environmentVariables["HOME"];
  const path = request.environmentVariables["PATH"];
  return {
    ...(home === undefined ? {} : { HOME: home }),
    ...(path === undefined ? {} : { PATH: path }),
    NO_COLOR: "1",
    [updates.disableEnvironmentVariable]: "off",
  };
}

/** Reads one variable at the moment of use, treating an empty value as unset. */
function readVariable(
  environmentVariables: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environmentVariables[name];
  return value === undefined || value === "" ? undefined : value;
}
