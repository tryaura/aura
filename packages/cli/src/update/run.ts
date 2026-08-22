import type { Readable, Writable } from "node:stream";

import { attemptsFor, readUpdateCache, shouldCheck, writeUpdateCache } from "./cache.js";
import { createUpdateDebug, startUpdateProgress, type UpdateDebug } from "./diagnostics.js";
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
  readonly argv: readonly string[];
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
 *
 * Swallowed for the user, not for the developer: each refusal names itself through {@link debug},
 * which writes only when this distribution's debug variable asks it to.
 */
export async function runStartupUpdate(request: StartupUpdateRequest): Promise<void> {
  const debug = createUpdateDebug(request.updates, request.environmentVariables, request.stderr);
  try {
    const verdict = await eligibleInstallation({ ...request, version: request.branding.version });
    if (verdict.kind !== "eligible") {
      debug(`skipped: ${verdict.reason}`);
      return;
    }
    await check(request, verdict.installation, debug);
  } catch {
    // An updater that throws must still leave the command it interrupted able to run.
    debug("skipped: unexpected-error");
  }
}

async function check(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  debug: UpdateDebug,
): Promise<void> {
  const now = request.now().getTime();
  const identity = sourceIdentity(eligible.updates.source, request.branding.command);
  const entry = await readUpdateCache(request.homeDir, identity, now);
  if (!shouldCheck(entry, now)) {
    debug(`skipped: cached-${entry?.outcome ?? "check"}`);
    return;
  }

  const resolution = await resolveUpdateSource(eligible.updates.source, {
    command: request.branding.command,
    // Revalidation is offered only when the cached answer was "nothing newer". A cached candidate
    // has to be re-resolved in full, because the credential its download needs is deliberately not
    // in the cache and only a fresh document can rebuild it.
    ...(entry?.outcome === "current" && entry.etag !== undefined ? { etag: entry.etag } : {}),
    httpGet: request.httpGet,
    now,
    readVariable: (name) => readVariable(request.environmentVariables, name),
    target: eligible.target,
    userAgent: `${request.branding.command}/${eligible.version}`,
    version: eligible.version,
  });
  debug(
    resolution.kind === "failure"
      ? `resolved: ${resolution.reason}`
      : `resolved: ${resolution.kind}`,
  );

  await apply(request, eligible, { debug, entry, identity, now, resolution });
}

/** Everything one applied resolution needs that is not the request or the installation. */
interface ApplyContext {
  readonly debug: UpdateDebug;
  readonly entry: Awaited<ReturnType<typeof readUpdateCache>>;
  readonly identity: string;
  readonly now: number;
  readonly resolution: UpdateResolution;
}

async function apply(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  context: ApplyContext,
): Promise<void> {
  const { entry, identity, now, resolution } = context;
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

  const outcome = await install(request, eligible, resolution, now);
  context.debug(`installed: ${outcome.kind}`);
  report(request, eligible, resolution.candidate.version, outcome);
  await record(
    request,
    identity,
    now,
    resolution,
    outcome,
    attemptsFor(entry, resolution.candidate.version),
  );
}

/** The transaction, with the progress frame painted around it and always taken back down. */
async function install(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  resolution: Extract<UpdateResolution, { kind: "candidate" }>,
  now: number,
): Promise<InstallOutcome> {
  const { candidate } = resolution;
  request.stderr.write(updatingLine(request.branding, eligible.version, candidate.version));
  const progress = startUpdateProgress(request.stderr);
  try {
    return await installUpdate({
      candidate,
      command: request.branding.command,
      downloadHeaders: resolution.downloadHeaders,
      executablePath: eligible.executablePath,
      host: request.host,
      now,
      ...(progress.report === undefined ? {} : { onProgress: progress.report }),
      probeEnvironment: probeEnvironment(request, eligible.updates),
    });
  } finally {
    progress.close();
  }
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
  // `skipped` means another updater already installed this release, or had raced ahead of it — the
  // executable on disk is current either way, so recording anything else would ask this machine to
  // re-check within the hour for an answer it already has.
  if (outcome.kind === "installed" || outcome.kind === "skipped") {
    return writeUpdateCache(request.homeDir, identity, { checkedAt: now, outcome: "current" });
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
