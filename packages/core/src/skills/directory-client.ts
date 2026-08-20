import type { DirectorySkillSource, Environment, ResolvedSkillPack } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import { createLimiter } from "../workspace/concurrency.js";
import { failedResolution, partitionResolutions } from "../workspace/resolution.js";
import { treeHash } from "../workspace/skill-tree-walk.js";
import { listAgenticSkills, resolveAgenticSkills } from "./agenticskills-client.js";
import {
  describeCacheAge,
  readCatalogCache,
  writeCatalogCache,
  type CachedCatalog,
} from "./catalog-cache.js";
import type { DirectoryListingOptions, DirectorySkillListingResult } from "./directory-listing.js";
import {
  directoryEndpoint,
  failureHint,
  failureReasonText,
  request,
  statusHint,
  statusReasonText,
} from "./directory-transport.js";
import { parseDirectoryIndex, type DirectoryIndex } from "./index-schema.js";
import {
  MAX_CONCURRENT_SKILL_REQUESTS,
  MAX_DIRECTORY_INDEX_BYTES,
  MAX_SKILL_RESPONSE_BYTES,
} from "./limits.js";
import { parseDirectorySkillPack } from "./pack-schema.js";
import { skillIdProblem } from "./path-guards.js";

const DIRECTORY_DIAGNOSTIC_ID = "core/skill-directory";

/**
 * Fetches a directory's index, through the on-disk catalog cache for public sources.
 *
 * A fresh cache entry serves with no request at all; a stale one revalidates with `If-None-Match`
 * and serves on a 304; and a source that cannot be reached falls back to the stale copy with a
 * diagnostic naming its age, because a day-old listing beats an empty picker. Private directories
 * are never cached: their listings are credential-gated content, and the cache is not.
 *
 * A missing token is the probe outcome, not an error: the source lists as unavailable with the
 * variable to set, no request is made, and nothing is logged. Every other failure becomes one
 * diagnostic in the house voice. The token itself is read at request time inside the transport
 * and structurally cannot reach a diagnostic.
 */
export async function listDirectorySkills(
  environment: Environment,
  source: DirectorySkillSource,
  options: DirectoryListingOptions = {},
): Promise<DirectorySkillListingResult> {
  if (source.kind === "directory" && source.protocol === "agenticskills") {
    return listAgenticSkills(environment, source, options);
  }
  const endpoint = directoryEndpoint(source.url, "index.json");
  const cacheEndpoint =
    source.kind === "directory" && options.noCache !== true && endpoint.kind === "url"
      ? endpoint.url
      : undefined;
  const cached =
    cacheEndpoint === undefined ? undefined : await readCatalogCache(environment, cacheEndpoint);
  if (cached?.fresh === true) {
    return indexResult(source, parseDirectoryIndex(cached.body), [
      servedFromCache(source, cached.ageMs),
    ]);
  }

  const outcome = await request(
    environment,
    source,
    "index.json",
    MAX_DIRECTORY_INDEX_BYTES,
    cached?.etag,
  );
  if (outcome.kind === "missing-token") {
    return {
      diagnostics: [],
      listings: [],
      status: { hint: `set ${outcome.variable}`, kind: "unavailable" },
    };
  }
  return settleIndexOutcome(environment, source, outcome, cacheEndpoint, cached);
}

/** Folds one index response — 200, a revalidating 304, an error status, or a failure — in. */
async function settleIndexOutcome(
  environment: Environment,
  source: DirectorySkillSource,
  outcome: { readonly kind: "failure"; readonly reason: string } | IndexResponse,
  cacheEndpoint: string | undefined,
  cached: CachedCatalog | undefined,
): Promise<DirectorySkillListingResult> {
  if (outcome.kind === "response" && outcome.status === 304 && cached !== undefined) {
    if (cacheEndpoint !== undefined) {
      await writeCatalogCache(environment, cacheEndpoint, cached.body, cached.etag);
    }
    return indexResult(source, parseDirectoryIndex(cached.body));
  }
  if (outcome.kind === "response" && outcome.status === 200) {
    if (cacheEndpoint !== undefined) {
      await writeCatalogCache(environment, cacheEndpoint, outcome.body, outcome.etag);
    }
    return indexResult(source, parseDirectoryIndex(outcome.body));
  }
  if (cached !== undefined) {
    return staleFallback(source, cached.body, cached.ageMs);
  }
  return unavailable(source, outcome);
}

interface IndexResponse {
  readonly body: string;
  readonly etag?: string | undefined;
  readonly kind: "response";
  readonly status: number;
}

/** One available listing result, from a live body or a cached one — same validation either way. */
function indexResult(
  source: DirectorySkillSource,
  index: DirectoryIndex,
  extraDiagnostics: readonly ScanDiagnostic[] = [],
): DirectorySkillListingResult {
  return {
    diagnostics: [
      ...extraDiagnostics,
      ...index.problems.map((problem) => ({
        adapterId: DIRECTORY_DIAGNOSTIC_ID,
        message: `Skill source "${source.id}" index ${problem}, so some of it is unavailable.`,
        phase: "read" as const,
      })),
    ],
    listings: index.listings.map((listing) => Object.freeze({ ...listing, source })),
    status: { kind: "available" },
    ...(index.truncation === undefined ? {} : { truncation: index.truncation }),
  };
}

function servedFromCache(source: DirectorySkillSource, ageMs: number): ScanDiagnostic {
  return {
    adapterId: DIRECTORY_DIAGNOSTIC_ID,
    message:
      `Skill source "${source.id}" listing served from the local cache ` +
      `(${describeCacheAge(ageMs)}); pass --no-cache to refetch it now.`,
    phase: "read",
  };
}

/** The stale copy with a diagnostic naming its age: a dated listing beats an empty picker. */
function staleFallback(
  source: DirectorySkillSource,
  body: string,
  ageMs: number,
): DirectorySkillListingResult {
  return indexResult(source, parseDirectoryIndex(body), [
    {
      adapterId: DIRECTORY_DIAGNOSTIC_ID,
      message:
        `Skill source "${source.id}" could not be reached, so its listing is served from the ` +
        `local cache (${describeCacheAge(ageMs)}).`,
      phase: "read",
    },
  ]);
}

/** Fetches and validates the named skills, one failure per skill rather than one for all. */
export async function resolveDirectorySkills(
  environment: Environment,
  source: DirectorySkillSource,
  skillIds: readonly string[],
): Promise<{
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skills: readonly ResolvedSkillPack[];
}> {
  if (source.kind === "directory" && source.protocol === "agenticskills") {
    return resolveAgenticSkills(environment, source, skillIds);
  }
  const limit = createLimiter(MAX_CONCURRENT_SKILL_REQUESTS);
  const outcomes = await Promise.all(
    skillIds.map((skillId) =>
      limit(async () => {
        const reason = await resolveProblem(environment, source, skillId);
        if (typeof reason === "string") {
          return failedResolution<ResolvedSkillPack>(
            DIRECTORY_DIAGNOSTIC_ID,
            `Skill "${safeId(skillId)}" from "${source.id}" ${reason}, so it is unavailable.`,
            "read",
          );
        }
        return { kind: "resolved" as const, value: reason };
      }),
    ),
  );

  const { diagnostics, values } = partitionResolutions(outcomes);
  return { diagnostics, skills: values };
}

/** One resolved pack, or the reason fragment for its diagnostic. */
async function resolveProblem(
  environment: Environment,
  source: DirectorySkillSource,
  skillId: string,
): Promise<ResolvedSkillPack | string> {
  if (skillIdProblem(skillId) !== undefined) {
    return skillIdProblem(skillId) ?? "has an invalid ID";
  }

  const outcome = await request(environment, source, `skills/${skillId}`, MAX_SKILL_RESPONSE_BYTES);
  if (outcome.kind === "missing-token") {
    return `needs the ${outcome.variable} environment variable`;
  }
  if (outcome.kind !== "response") {
    return failureReasonText(outcome.reason);
  }
  if (outcome.status !== 200) {
    return statusReasonText(source, outcome.status);
  }

  const pack = parseDirectorySkillPack(outcome.body, skillId);
  if (pack.kind === "invalid") {
    return pack.problem;
  }
  return Object.freeze({
    ...pack.listing,
    files: pack.files,
    source,
    treeHash: treeHash(pack.files),
  });
}

/** An id safe to quote in a diagnostic: validated ids only, never raw caller or server bytes. */
function safeId(id: string): string {
  return skillIdProblem(id) === undefined ? id : "<invalid id>";
}

function unavailable(
  source: DirectorySkillSource,
  outcome: { readonly kind: "failure"; readonly reason: string } | { readonly status: number },
): DirectorySkillListingResult {
  const reason =
    "reason" in outcome
      ? failureReasonText(outcome.reason)
      : statusReasonText(source, outcome.status);
  const hint =
    "reason" in outcome ? failureHint(outcome.reason) : statusHint(source, outcome.status);
  return {
    diagnostics: [
      {
        adapterId: DIRECTORY_DIAGNOSTIC_ID,
        message: `Skill source "${source.id}" ${reason}, so it is unavailable.`,
        phase: "read",
      },
    ],
    listings: [],
    status: { hint, kind: "unavailable" },
  };
}
