import type { DirectorySkillSource, Environment } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { agenticRequestFailure, getAgenticResource } from "./agenticskills-http.js";
import type { AgenticCatalogEntry, AgenticCatalogOutcome } from "./agenticskills-types.js";
import { parseCatalogEntry, UNSUPPORTED_COLLECTION } from "./agenticskills-entry.js";
import { readCatalogCache, writeCatalogCache, type CachedCatalog } from "./catalog-cache.js";
import { MAX_DIRECTORY_INDEX_BYTES, MAX_DIRECTORY_INDEX_ENTRIES } from "./limits.js";

/**
 * The feed each endpoint served, scoped to the environment that fetched it.
 *
 * Listing and resolving are separate entry points that both need the whole feed, and resolving
 * runs after the user has picked — refetching there costs a second full download and can disagree
 * with the catalog the picker was built from. Memoizing makes the two agree by construction.
 * Keying on the environment rather than the module keeps one run's answers out of the next one's.
 */
const catalogs = new WeakMap<Environment, Map<string, Promise<AgenticCatalogOutcome>>>();

export function loadAgenticCatalog(
  environment: Environment,
  source: DirectorySkillSource,
  noCache = false,
): Promise<AgenticCatalogOutcome> {
  const endpoint = providerEndpoint(source.url);
  if (endpoint === undefined) {
    return Promise.resolve({ kind: "failure", reason: "has a URL that does not parse" });
  }
  const byEndpoint = catalogs.get(environment) ?? new Map<string, Promise<AgenticCatalogOutcome>>();
  catalogs.set(environment, byEndpoint);
  const memoized = byEndpoint.get(endpoint);
  if (memoized !== undefined) {
    return memoized;
  }
  const pending = fetchCatalog(environment, endpoint, noCache);
  byEndpoint.set(endpoint, pending);
  return pending;
}

/**
 * The feed body, through the on-disk catalog cache.
 *
 * Fresh entries serve with no request; stale ones revalidate with `If-None-Match` and serve on a
 * 304; and an unreachable provider falls back to the stale copy, because a dated catalog beats an
 * empty picker. Both bodies validate through the same {@link parseCatalog}, so a cached document
 * is never trusted further than a live one.
 */
async function fetchCatalog(
  environment: Environment,
  endpoint: string,
  noCache: boolean,
): Promise<AgenticCatalogOutcome> {
  const cached = noCache ? undefined : await readUsableCatalog(environment, endpoint);
  if (cached !== undefined && cached.entry.fresh) {
    return { ...cached.catalog, cacheAgeMs: cached.entry.ageMs };
  }
  const outcome = await getAgenticResource(environment, {
    ...(cached?.entry.etag === undefined
      ? {}
      : { headers: { "If-None-Match": cached.entry.etag } }),
    maxResponseBytes: MAX_DIRECTORY_INDEX_BYTES,
    url: endpoint,
  });
  return settleCatalogOutcome(environment, endpoint, noCache, outcome, cached);
}

interface UsableCachedCatalog {
  readonly catalog: AgenticCatalogOutcome & { readonly kind: "catalog" };
  readonly entry: CachedCatalog;
}

/**
 * The cached entry together with its parse, or `undefined` when there is nothing usable.
 *
 * A cached body that no longer parses is a miss outright, including for revalidation: a 304 would
 * confirm bytes this run cannot use.
 */
async function readUsableCatalog(
  environment: Environment,
  endpoint: string,
): Promise<UsableCachedCatalog | undefined> {
  const entry = await readCatalogCache(environment, endpoint);
  if (entry === undefined) {
    return undefined;
  }
  const catalog = parseCatalog(entry.body);
  return catalog.kind === "catalog" ? { catalog, entry } : undefined;
}

/** Folds one feed response — a body, a revalidating 304, or a failure — into the outcome. */
async function settleCatalogOutcome(
  environment: Environment,
  endpoint: string,
  noCache: boolean,
  outcome: Awaited<ReturnType<typeof getAgenticResource>>,
  cached: UsableCachedCatalog | undefined,
): Promise<AgenticCatalogOutcome> {
  if (outcome.kind === "not-modified" && cached !== undefined) {
    await writeCatalogCache(environment, endpoint, cached.entry.body, cached.entry.etag);
    return cached.catalog;
  }
  if (outcome.kind === "failure" || outcome.kind === "not-modified") {
    return catalogFallback(outcome, cached);
  }
  if (outcome.kind !== "text") {
    return { kind: "failure", reason: "returned a non-text catalog" };
  }
  const parsed = parseCatalog(outcome.body);
  if (!noCache && parsed.kind === "catalog") {
    await writeCatalogCache(environment, endpoint, outcome.body, outcome.etag);
  }
  return parsed;
}

/** The stale copy when one is usable, else the failure in the words the picker will show. */
function catalogFallback(
  outcome:
    | { readonly kind: "failure"; readonly reason: string }
    | { readonly kind: "not-modified" },
  cached: UsableCachedCatalog | undefined,
): AgenticCatalogOutcome {
  if (cached !== undefined) {
    return { ...cached.catalog, cacheAgeMs: cached.entry.ageMs, staleAfterFailure: true };
  }
  const reason = outcome.kind === "failure" ? outcome.reason : "responded with HTTP 304";
  return { kind: "failure", reason: agenticRequestFailure(reason) };
}

function providerEndpoint(baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return new URL("api/skills", base).href;
  } catch {
    return undefined;
  }
}

// fallow-ignore-next-line complexity -- every branch drops or bounds one untrusted feed shape.
function parseCatalog(body: string): AgenticCatalogOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "failure", reason: "returned a catalog that is not valid JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["skills"])) {
    return { kind: "failure", reason: "returned a catalog without a skills array" };
  }

  const entries: AgenticCatalogEntry[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  const advertised = parsed["skills"];
  for (const candidate of advertised.slice(0, MAX_DIRECTORY_INDEX_ENTRIES)) {
    const entry = parseCatalogEntry(candidate);
    if (entry === UNSUPPORTED_COLLECTION) {
      continue;
    }
    if (entry === undefined || seen.has(entry.listing.id)) {
      malformed += 1;
      continue;
    }
    seen.add(entry.listing.id);
    entries.push(entry);
  }
  const problems: string[] = [];
  const truncated = advertised.length > MAX_DIRECTORY_INDEX_ENTRIES;
  if (truncated) {
    problems.push(
      `advertises ${String(advertised.length)} entries; only the first ${String(MAX_DIRECTORY_INDEX_ENTRIES)} are read`,
    );
  }
  if (malformed > 0) {
    problems.push(`contains ${String(malformed)} malformed or duplicate entries`);
  }
  return {
    entries: Object.freeze(entries),
    kind: "catalog",
    problems: Object.freeze(problems),
    ...(truncated
      ? { truncation: { advertised: advertised.length, read: MAX_DIRECTORY_INDEX_ENTRIES } }
      : {}),
  };
}
