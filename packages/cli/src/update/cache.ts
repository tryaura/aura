import { cacheLocation, readCacheEnvelope, writeCacheEnvelope } from "@tryaura/core";

import {
  CHECK_FRESH_MS,
  CHECK_RETRY_MS,
  INSTALL_BACKOFF_BASE_MS,
  INSTALL_BACKOFF_MAX_MS,
  MAX_ARCHIVE_BYTES,
  MAX_CACHE_BYTES,
} from "./limits.js";
import { asDigest, asRecord, asSize, asText } from "./narrow.js";
import type { CliUpdateCandidate } from "./types.js";

/**
 * Where update metadata lives, beside every other cache Aura keeps.
 *
 * The entry is machine state, not workspace content: `0700` directories, `0600` files, and
 * temporary-file renames, all inherited from the shared cache primitives.
 */
const NAMESPACE = "distribution-updates";

const OUTCOMES: Readonly<Record<string, UpdateCacheEntry["outcome"]>> = {
  candidate: "candidate",
  "check-failed": "check-failed",
  current: "current",
};

/** What the last check concluded, and how many installations of it have already failed. */
export interface UpdateCacheEntry {
  /** The release the last successful check named, when it named a newer one. */
  readonly candidate?: CliUpdateCandidate | undefined;
  readonly checkedAt: number;
  /** Entity tag of the metadata document, so the next check can revalidate instead of refetch. */
  readonly etag?: string | undefined;
  readonly failedAt?: number | undefined;
  readonly failedAttempts?: number | undefined;
  readonly outcome: "candidate" | "check-failed" | "current";
}

/**
 * Reads the entry for one source, or `undefined` for every reason it cannot be used.
 *
 * Corruption, truncation, a changed source identity, and a timestamp from the future are all
 * misses rather than errors. A cache is an optimization: it may cost a run one extra request, and
 * it may never be the reason a command the user asked for behaves differently.
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
  if (value === undefined || value["identity"] !== identity) {
    return undefined;
  }
  const checkedAt = value["checkedAt"];
  const outcome = value["outcome"];
  if (typeof checkedAt !== "number" || checkedAt > now || typeof outcome !== "string") {
    return undefined;
  }
  return narrowEntry(value, checkedAt, outcome, now);
}

/** Stores one entry, treating any write failure as nothing having happened. */
export async function writeUpdateCache(
  homeDir: string,
  identity: string,
  entry: UpdateCacheEntry,
): Promise<void> {
  await writeCacheEnvelope(cacheLocation({ homeDir }, NAMESPACE, identity), {
    identity,
    ...entry,
  });
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
  return entry?.candidate?.version === version ? (entry.failedAttempts ?? 0) : 0;
}

function nextInstallAttempt(entry: UpdateCacheEntry): number {
  const attempts = entry.failedAttempts ?? 0;
  if (attempts === 0 || entry.failedAt === undefined) {
    return entry.checkedAt;
  }
  const delay = Math.min(INSTALL_BACKOFF_BASE_MS * 2 ** (attempts - 1), INSTALL_BACKOFF_MAX_MS);
  return entry.failedAt + delay;
}

function narrowEntry(
  value: Record<string, unknown>,
  checkedAt: number,
  rawOutcome: string,
  now: number,
): UpdateCacheEntry | undefined {
  const outcome = OUTCOMES[rawOutcome];
  const candidate = narrowCandidate(value["candidate"]);
  if (outcome === undefined || (outcome === "candidate" && candidate === undefined)) {
    return undefined;
  }
  return {
    ...(candidate === undefined ? {} : { candidate }),
    checkedAt,
    ...narrowEtag(value),
    ...narrowAttempts(value, now),
    outcome,
  };
}

function narrowEtag(value: Record<string, unknown>): { readonly etag?: string } {
  const etag = asText(value["etag"]);
  return etag === undefined ? {} : { etag };
}

function narrowAttempts(
  value: Record<string, unknown>,
  now: number,
): { readonly failedAt?: number; readonly failedAttempts?: number } {
  const failedAt = asSize(value["failedAt"], now);
  const failedAttempts = asSize(value["failedAttempts"], Number.MAX_SAFE_INTEGER);
  return {
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(failedAttempts === undefined ? {} : { failedAttempts }),
  };
}

/** Re-narrows a cached candidate: a file on disk is unknown input exactly like a server response. */
function narrowCandidate(value: unknown): CliUpdateCandidate | undefined {
  const record = asRecord(value);
  const archive = narrowArchive(record?.["archive"]);
  const version = asText(record?.["version"]);
  return archive === undefined || version === undefined ? undefined : { archive, version };
}

function narrowArchive(value: unknown): CliUpdateCandidate["archive"] | undefined {
  const archive = asRecord(value);
  const downloadUrl = asText(archive?.["downloadUrl"]);
  const sha256 = asDigest(archive?.["sha256"]);
  const size = asSize(archive?.["size"], MAX_ARCHIVE_BYTES);
  if (downloadUrl === undefined || sha256 === undefined || size === undefined) {
    return undefined;
  }
  return { downloadUrl, sha256, size };
}
