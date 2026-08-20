import type { DirectorySkillSource, Environment, ResolvedSkillPack } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import { createLimiter } from "../workspace/concurrency.js";
import { loadAgenticCatalog } from "./agenticskills-catalog.js";
import type { DirectoryListingOptions, DirectorySkillListingResult } from "./directory-listing.js";
import { resolveAgenticEntry, startAgenticVerification } from "./agenticskills-github.js";
import { AGENTICSKILLS_DIAGNOSTIC_ID, type AgenticCatalogEntry } from "./agenticskills-types.js";
import { describeCacheAge } from "./catalog-cache.js";
import { MAX_CONCURRENT_SKILL_REQUESTS } from "./limits.js";
import { skillIdProblem } from "./path-guards.js";

/** Lists the metadata feed AgenticSkills publishes and translates it into Aura listings. */
export async function listAgenticSkills(
  environment: Environment,
  source: DirectorySkillSource,
  options: DirectoryListingOptions = {},
): Promise<DirectorySkillListingResult> {
  const catalog = await loadAgenticCatalog(environment, source, options.noCache === true);
  if (catalog.kind === "failure") {
    return {
      diagnostics: [
        diagnostic(`Skill source "${source.id}" ${catalog.reason}, so it is unavailable.`),
      ],
      listings: [],
      status: { hint: "unreachable", kind: "unavailable" },
    };
  }
  return {
    collections: catalog.collections,
    diagnostics: [
      ...cacheDiagnostics(source, catalog),
      ...catalog.problems.map((problem) =>
        diagnostic(`Skill source "${source.id}" catalog ${problem}, so some of it is unavailable.`),
      ),
    ],
    listings: Object.freeze(
      catalog.entries.map(({ listing }) => Object.freeze({ ...listing, source })),
    ),
    status: { kind: "available" },
    ...(catalog.truncation === undefined ? {} : { truncation: catalog.truncation }),
    verification: startAgenticVerification(environment, catalog.entries),
  };
}

/** Names where a cached body came from, so a run never mistakes a cached listing for a live one. */
function cacheDiagnostics(
  source: DirectorySkillSource,
  catalog: {
    readonly cacheAgeMs?: number | undefined;
    readonly staleAfterFailure?: boolean | undefined;
  },
): readonly ScanDiagnostic[] {
  if (catalog.cacheAgeMs === undefined) {
    return [];
  }
  const age = describeCacheAge(catalog.cacheAgeMs);
  return [
    diagnostic(
      catalog.staleAfterFailure === true
        ? `Skill source "${source.id}" could not be reached, so its listing is served from the local cache (${age}).`
        : `Skill source "${source.id}" listing served from the local cache (${age}); pass --no-cache to refetch it now.`,
    ),
  ];
}

/** Resolves AgenticSkills entries from their exact GitHub directories into reviewed Aura packs. */
export async function resolveAgenticSkills(
  environment: Environment,
  source: DirectorySkillSource,
  skillIds: readonly string[],
): Promise<{
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skills: readonly ResolvedSkillPack[];
}> {
  const catalog = await loadAgenticCatalog(environment, source);
  const entries = catalogEntries(catalog);
  const limit = createLimiter(MAX_CONCURRENT_SKILL_REQUESTS);
  const outcomes = await Promise.all(
    skillIds.map((skillId) =>
      limit(async (): Promise<ResolvedSkillPack | ScanDiagnostic> => {
        if (skillIdProblem(skillId) !== undefined) {
          return skillDiagnostic(source, "<invalid id>", "has an invalid ID");
        }
        if (catalog.kind === "failure") {
          return skillDiagnostic(source, skillId, catalog.reason);
        }
        const entry = entries.get(skillId);
        if (entry === undefined) {
          return skillDiagnostic(source, skillId, "is no longer advertised by its source");
        }
        const resolved = await resolveAgenticEntry(environment, source, entry);
        return typeof resolved === "string" ? skillDiagnostic(source, skillId, resolved) : resolved;
      }),
    ),
  );
  return {
    diagnostics: Object.freeze(outcomes.filter(isDiagnostic)),
    skills: Object.freeze(outcomes.filter(isResolvedPack)),
  };
}

function catalogEntries(
  catalog: Awaited<ReturnType<typeof loadAgenticCatalog>>,
): ReadonlyMap<string, AgenticCatalogEntry> {
  return catalog.kind === "catalog"
    ? new Map(catalog.entries.map((entry) => [entry.listing.id, entry]))
    : new Map<string, AgenticCatalogEntry>();
}

function diagnostic(message: string): ScanDiagnostic {
  return { adapterId: AGENTICSKILLS_DIAGNOSTIC_ID, message, phase: "read" };
}

function skillDiagnostic(source: DirectorySkillSource, id: string, reason: string): ScanDiagnostic {
  return diagnostic(`Skill "${id}" from "${source.id}" ${reason}, so it is unavailable.`);
}

function isDiagnostic(value: ResolvedSkillPack | ScanDiagnostic): value is ScanDiagnostic {
  return "adapterId" in value;
}

function isResolvedPack(value: ResolvedSkillPack | ScanDiagnostic): value is ResolvedSkillPack {
  return "treeHash" in value;
}
