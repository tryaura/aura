import type { Readable, Writable } from "node:stream";

import { attemptsFor, readUpdateCache, shouldCheck, writeUpdateCache } from "./cache.js";
import {
  createUpdateDebug,
  startUpdateProgress,
  updateEnvironmentVariable,
  type UpdateDebug,
} from "./diagnostics.js";
import { eligibleInstallation, type EligibleInstallation } from "./eligibility.js";
import { installUpdate, type InstallOutcome } from "./install.js";
import { STARTUP_UPDATE_BUDGET_MS } from "./limits.js";
import { appliedUpdateOutcome, traceInstallOutcome, type StartupUpdateOutcome } from "./outcome.js";
import {
  resolveUpdateSource,
  sourceIdentity,
  type UpdateHttpGet,
  type UpdateResolution,
} from "./provider.js";
import type { UpdateHost } from "./host.js";
import type { CliBranding } from "../types.js";
import type { CliUpdates } from "./types.js";

/** Everything the startup update reads, injected so a run reads nothing from the process itself. */
export interface StartupUpdateRequest {
  readonly argv: readonly string[];
  readonly branding: CliBranding;
  /** Ignore cached outcomes and resolve the release source now. */
  readonly bypassCache?: boolean | undefined;
  readonly current: Pick<NodeJS.Process, "arch" | "execPath" | "platform">;
  readonly environmentVariables: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly host: UpdateHost;
  readonly httpGet: UpdateHttpGet;
  readonly now: () => Date;
  readonly stderr: Writable;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly updates: CliUpdates;
}

/**
 * Runs the silent startup check and returns its outcome for an explicit caller to report.
 * The successfully updated executable is used by the next invocation.
 */
export async function runStartupUpdate(
  request: StartupUpdateRequest,
): Promise<StartupUpdateOutcome> {
  const disableEnvironmentVariable = updateEnvironmentVariable(request.branding.command);
  const debug = createUpdateDebug(
    disableEnvironmentVariable,
    request.environmentVariables,
    request.stderr,
  );
  try {
    const verdict = await eligibleInstallation({
      ...request,
      disableEnvironmentVariable,
      version: request.branding.version,
    });
    if (verdict.kind !== "eligible") {
      debug(`skipped: ${verdict.reason}`);
      return { kind: "skipped", reason: verdict.reason };
    }
    return await check(request, verdict.installation, debug);
  } catch {
    // An updater that throws must still leave the command it interrupted able to run.
    debug("skipped: unexpected-error");
    return { kind: "failed", reason: "unexpected" };
  }
}

async function check(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  debug: UpdateDebug,
): Promise<StartupUpdateOutcome> {
  const now = request.now().getTime();
  const identity = sourceIdentity(request.updates, request.branding.command);
  const entry = request.bypassCache
    ? undefined
    : await readUpdateCache(request.homeDir, identity, now);
  if (!shouldCheck(entry, now)) {
    debug(`skipped: cached-${entry?.outcome ?? "check"}`);
    return { kind: "skipped", reason: "cached" };
  }

  const resolution = await resolveUpdateSource(request.updates, {
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

  return await apply(request, eligible, {
    // Anchored to the moment the check started, not to the moment the install does: what the
    // budget bounds is the wait between the user's keystroke and their command, and the metadata
    // request and the probe of the installed binary are already part of that wait.
    deadline: now + STARTUP_UPDATE_BUDGET_MS,
    debug,
    entry,
    identity,
    now,
    resolution,
  });
}

/** Everything one applied resolution needs that is not the request or the installation. */
interface ApplyContext {
  readonly deadline: number;
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
): Promise<StartupUpdateOutcome> {
  const { entry, identity, now, resolution } = context;
  if (resolution.kind === "failure") {
    await writeUpdateCache(request.homeDir, identity, { checkedAt: now, outcome: "check-failed" });
    return { kind: "failed", reason: resolution.reason };
  }
  if (resolution.kind !== "candidate") {
    // A 304 response may carry no entity tag of its own; the cached one still names the
    // representation the server just confirmed, so it survives to the next revalidation.
    const etag = resolution.kind === "current" ? (resolution.etag ?? entry?.etag) : entry?.etag;
    await writeUpdateCache(request.homeDir, identity, {
      checkedAt: now,
      ...(etag === undefined ? {} : { etag }),
      outcome: "current",
    });
    return { kind: "current" };
  }

  const outcome = await install(request, eligible, resolution, context);
  context.debug(`installed: ${traceInstallOutcome(outcome)}`);
  report(request, eligible, resolution.candidate.version, outcome);
  await record(
    request,
    identity,
    now,
    resolution,
    outcome,
    attemptsFor(entry, resolution.candidate.version),
  );
  return appliedUpdateOutcome(resolution.candidate.version, outcome);
}

/** The transaction, with the progress frame painted around it and always taken back down. */
async function install(
  request: StartupUpdateRequest,
  eligible: EligibleInstallation,
  resolution: Extract<UpdateResolution, { kind: "candidate" }>,
  context: ApplyContext,
): Promise<InstallOutcome> {
  const { candidate } = resolution;
  request.stderr.write(updatingLine(request.branding, eligible.version, candidate.version));
  const progress = startUpdateProgress(request.stderr);
  try {
    return await installUpdate({
      candidate,
      command: request.branding.command,
      downloadHeaders: resolution.downloadHeaders,
      // Whatever the steps before it did not spend. A budget already exhausted yields a transfer
      // that aborts at once, which the transaction reports like any other download that failed.
      downloadTimeoutMs: Math.max(0, context.deadline - request.now().getTime()),
      executablePath: eligible.executablePath,
      host: request.host,
      now: context.now,
      ...(progress.report === undefined ? {} : { onProgress: progress.report }),
      probeEnvironment: probeEnvironment(request),
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
    const manual = request.updates.manualUpdateUrl ?? request.branding.docsUrl;
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
    checkedAt: now,
    ...(resolution.etag === undefined ? {} : { etag: resolution.etag }),
    failedAttempts: attempts + 1,
    failedVersion: resolution.candidate.version,
    outcome: "install-failed",
  });
}

/**
 * The environment a version probe runs in.
 *
 * Deliberately tiny, and deliberately carrying this distribution's own disable variable: the
 * installer verifies a staged binary by running it, and a child that started an update of its own
 * would recurse into the directory its parent is mid-transaction on.
 */
function probeEnvironment(request: StartupUpdateRequest): Record<string, string> {
  const home = request.environmentVariables["HOME"];
  const path = request.environmentVariables["PATH"];
  return {
    ...(home === undefined ? {} : { HOME: home }),
    ...(path === undefined ? {} : { PATH: path }),
    NO_COLOR: "1",
    [updateEnvironmentVariable(request.branding.command)]: "off",
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

function updatingLine(branding: CliBranding, from: string, to: string): string {
  return `Updating ${branding.displayName} ${from} -> ${to}...\n`;
}

function updatedLine(branding: CliBranding, to: string): string {
  return `Updated ${branding.displayName} to ${to}. The new version will be used on your next run.\n`;
}

function installFailedLine(
  branding: CliBranding,
  version: string,
  manualUpdateUrl: string | undefined,
): string {
  const suffix = manualUpdateUrl === undefined ? "" : ` Update manually: ${manualUpdateUrl}`;
  return `${branding.displayName} could not install the ${version} update.${suffix}\n`;
}

function digestRefusedLine(branding: CliBranding, version: string): string {
  return (
    `${branding.displayName} refused the ${version} update: the download did not match the ` +
    `release's published SHA-256 digest. Nothing was installed.\n`
  );
}
