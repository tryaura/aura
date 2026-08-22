import { cacheLocation, readCacheEnvelope, writeCacheEnvelope } from "@tryaura/core";

import {
  CHECK_FRESH_MS,
  CHECK_RETRY_MS,
  INSTALL_BACKOFF_BASE_MS,
  INSTALL_BACKOFF_MAX_MS,
  MAX_CACHE_BYTES,
} from "./limits.js";
import { asSize, asText } from "./narrow.js";

/**
 * Where update metadata lives, beside every other cache Aura keeps.
 *
 * The entry is machine state, not workspace content: `0700` directories, `0600` files, and
 * temporary-file renames, all inherited from the shared cache primitives.
 */
const NAMESPACE = "distribution-updates";

const OUTCOMES: Readonly<Record<string, UpdateCacheEntry["outcome"]>> = {
  "check-failed": "check-failed",
  current: "current",
  "install-failed": "install-failed",
};

/** What the last check concluded, and how many installations of its version have already failed. */
export interface UpdateCacheEntry {
  readonly checkedAt: number;
  /** Entity tag of the metadata document, so the next check can revalidate instead of refetch. */
  readonly etag?: string | undefined;
  readonly failedAttempts?: number | undefined;
  readonly failedVersion?: string | undefined;
  readonly outcome: "check-failed" | "current" | "install-failed";
}

/**
 * Reads the entry for one source, or `undefined` for every reason it cannot be used.
 *
 * Corruption, truncation, and a timestamp from the future are all misses rather than errors. A
 * changed source identity resolves to a different hashed path. A cache is only an optimization.
 */
export async function readUpdateCache(
  homeDir: string,
  identity: string,
  now: number,
): Promise<UpdateCacheEntry | undefined> {
  const value = await readCacheEnvelope(
    cacheLocation({ homeDir }, NAMESPACE, identity),
    MAX_CACHE_BYTES,
  );
  if (value === undefined) {
    return undefined;
  }
  const checkedAt = value["checkedAt"];
  const outcome = value["outcome"];
  if (typeof checkedAt !== "number" || checkedAt > now || typeof outcome !== "string") {
    return undefined;
  }
  return narrowEntry(value, checkedAt, outcome);
}

/** Stores one entry, treating any write failure as nothing having happened. */
export async function writeUpdateCache(
  homeDir: string,
  identity: string,
  entry: UpdateCacheEntry,
): Promise<void> {
  await writeCacheEnvelope(cacheLocation({ homeDir }, NAMESPACE, identity), { ...entry });
}

/**
 * Whether this run should ask the source for release metadata.
 *
 * The cadence is what keeps startup cheap and quiet: one successful check a day, one silent retry
 * an hour after a failure, and an exponential backoff per candidate version after an installation
 * that did not complete — so a machine that cannot write to its own install directory asks once,
 * then twice a day, rather than on every command.
 */
export function shouldCheck(entry: UpdateCacheEntry | undefined, now: number): boolean {
  if (entry === undefined) {
    return true;
  }
  if (entry.outcome === "current") {
    return now - entry.checkedAt >= CHECK_FRESH_MS;
  }
  if (entry.outcome === "check-failed") {
    return now - entry.checkedAt >= CHECK_RETRY_MS;
  }
  return now >= nextInstallAttempt(entry);
}

/**
 * Attempts already spent on one candidate version.
 *
 * A different version starts at zero: backoff exists to stop retrying a release that will not
 * install, not to punish the next one for it.
 */
export function attemptsFor(entry: UpdateCacheEntry | undefined, version: string): number {
  return entry?.failedVersion === version ? (entry.failedAttempts ?? 0) : 0;
}

function nextInstallAttempt(entry: UpdateCacheEntry): number {
  const attempts = entry.failedAttempts ?? 0;
  if (attempts === 0) {
    return entry.checkedAt;
  }
  const delay = Math.min(INSTALL_BACKOFF_BASE_MS * 2 ** (attempts - 1), INSTALL_BACKOFF_MAX_MS);
  return entry.checkedAt + delay;
}

function narrowEntry(
  value: Record<string, unknown>,
  checkedAt: number,
  rawOutcome: string,
): UpdateCacheEntry | undefined {
  const outcome = OUTCOMES[rawOutcome];
  const failedVersion = asText(value["failedVersion"]);
  if (outcome === undefined || (outcome === "install-failed" && failedVersion === undefined)) {
    return undefined;
  }
  return {
    checkedAt,
    ...narrowEtag(value),
    ...narrowFailure(value),
    outcome,
  };
}

function narrowEtag(value: Record<string, unknown>): { readonly etag?: string } {
  const etag = asText(value["etag"]);
  return etag === undefined ? {} : { etag };
}

function narrowFailure(value: Record<string, unknown>): {
  readonly failedAttempts?: number;
  readonly failedVersion?: string;
} {
  const failedAttempts = asSize(value["failedAttempts"], Number.MAX_SAFE_INTEGER);
  const failedVersion = asText(value["failedVersion"]);
  return {
    ...(failedAttempts === undefined ? {} : { failedAttempts }),
    ...(failedVersion === undefined ? {} : { failedVersion }),
  };
}
