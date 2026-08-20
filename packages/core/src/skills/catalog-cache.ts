import type { Environment } from "@tryaura/aura-sdk";

import { cacheLocation, readCacheEnvelope, writeCacheEnvelope } from "../workspace/disk-cache.js";
import { MAX_DIRECTORY_INDEX_BYTES } from "./limits.js";

/** How long a cached catalog serves with no network request at all. */
const CATALOG_CACHE_FRESH_MS = 60 * 60 * 1_000;

/**
 * How long a stale entry stays usable for revalidation and failure fallback.
 *
 * Past this age an entry is a miss outright: a week-old listing served because a source has been
 * unreachable for that long would present long-gone skills as installable with no end in sight.
 */
const CATALOG_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Doubled: the body is JSON stored inside JSON, so every quote costs one escape byte. */
const MAX_CACHE_BYTES = MAX_DIRECTORY_INDEX_BYTES * 2 + 4_096;

const NAMESPACE = "skill-catalogs";

/** One cached catalog document, still unvalidated — the caller parses it like a live response. */
export interface CachedCatalog {
  readonly ageMs: number;
  readonly body: string;
  /** The entity tag the source sent with this body, for `If-None-Match` revalidation. */
  readonly etag?: string | undefined;
  /** Whether the entry may serve without any request; a stale entry only revalidates. */
  readonly fresh: boolean;
}

/**
 * Returns the cached document for one endpoint, or `undefined` for any reason it cannot be used.
 *
 * Every failure is a miss rather than an error: the cache is an optimization, and a corrupt or
 * expired entry must never be the reason a run cannot list a catalog it could otherwise fetch.
 */
export async function readCatalogCache(
  environment: Environment,
  endpoint: string,
): Promise<CachedCatalog | undefined> {
  const value = await readCacheEnvelope(
    cacheLocation(environment, NAMESPACE, endpoint),
    MAX_CACHE_BYTES,
  );
  if (value === undefined) {
    return undefined;
  }
  const body = value["body"];
  const cachedAt = value["cachedAt"];
  const etag = value["etag"];
  const ageMs = environment.now().getTime() - (typeof cachedAt === "number" ? cachedAt : 0);
  if (
    typeof body !== "string" ||
    typeof cachedAt !== "number" ||
    (etag !== undefined && typeof etag !== "string") ||
    value["endpoint"] !== endpoint ||
    ageMs < 0 ||
    ageMs > CATALOG_CACHE_MAX_AGE_MS
  ) {
    return undefined;
  }
  return {
    ageMs,
    body,
    ...(etag === undefined ? {} : { etag }),
    fresh: ageMs <= CATALOG_CACHE_FRESH_MS,
  };
}

/** Stores one catalog body, treating any write failure as nothing having happened. */
export async function writeCatalogCache(
  environment: Environment,
  endpoint: string,
  body: string,
  etag: string | undefined,
): Promise<void> {
  await writeCacheEnvelope(cacheLocation(environment, NAMESPACE, endpoint), {
    body,
    cachedAt: environment.now().getTime(),
    endpoint,
    ...(etag === undefined ? {} : { etag }),
  });
}

/** Restates how old a cached copy is, in the roundest honest unit. */
export function describeCacheAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) {
    return "under a minute old";
  }
  if (minutes < 60) {
    return `${String(minutes)} min old`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} h old`;
  }
  return `${String(Math.floor(hours / 24))} d old`;
}
