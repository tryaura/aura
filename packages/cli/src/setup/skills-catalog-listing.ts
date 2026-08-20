import type {
  DirectorySkillSource,
  DriverSkillSource,
  PrivateDirectorySkillSource,
} from "@tryaura/aura-sdk";
import {
  createLimiter,
  isSkillSourceAllowed,
  listDirectorySkills,
  listDriverSkills,
  loadSkillPackGroups,
  type DriverSkillListingResult,
} from "@tryaura/core";

import { skillIdentity } from "./skill-planner-paths.js";
import type {
  SkillCatalogEntry,
  SkillCatalogInputs,
  SkillCatalogListing,
  SkillCatalogVerification,
  SkillSourceLoadUpdate,
  TruncatedSkillSource,
  UnavailableSkillSource,
} from "./skills-catalog.js";

/** How many skill sources the picker lists at once; each is one loading row on screen. */
const MAX_CONCURRENT_SOURCE_LISTINGS = 4;

/** Everything one listing pass reads, plus the per-run memos it fills in. */
export interface SkillListingRequest {
  /** Driver id → its in-flight or settled listing, memoized for the whole run. */
  readonly driverListings: Map<string, Promise<DriverSkillListingResult>>;
  readonly drivers: readonly DriverSkillSource[];
  readonly inputs: SkillCatalogInputs;
  /** Driver id → the skill ids it actually advertised; resolution refuses anything else. */
  readonly listedDriverSkills: Map<string, Set<string>>;
  /** Messages from reading the preset and collecting sources, surfaced ahead of listing notes. */
  readonly notes: readonly string[];
  readonly sources: readonly DirectorySkillSource[];
  readonly unapproved: readonly PrivateDirectorySkillSource[];
  readonly update: SkillSourceLoadUpdate | undefined;
}

/**
 * Lists every allowed source into one picker order: bundled, then directories, then drivers.
 *
 * Directories and drivers are independent I/O and start together — the step's whole latency sits
 * between the user and the picker, so serializing the two kinds would make them wait for the sum
 * of both. Only the draining is ordered, which is what keeps the picker's rows stable.
 */
export async function loadListing(request: SkillListingRequest): Promise<SkillCatalogListing> {
  const entries: SkillCatalogEntry[] = [...bundledEntries(request.inputs)];
  const notes = [...request.notes];
  const unavailableSources: UnavailableSkillSource[] = request.unapproved.map((source) => ({
    hint: `connection not approved; token ${source.tokenEnv}`,
    id: source.id,
    name: source.name,
  }));

  const limit = createLimiter(MAX_CONCURRENT_SOURCE_LISTINGS);
  const [packOutcome, directoryResults, driverResults] = await Promise.all([
    loadSkillPackGroups(request.inputs.registryPresets ?? []),
    Promise.all(
      request.sources.map((source) =>
        limit(async () => ({
          result: await reporting(request.update, source.id, () =>
            listDirectorySkills(request.inputs.environment, source, {
              noCache: request.inputs.noCache === true,
            }),
          ),
          source,
        })),
      ),
    ),
    Promise.all(
      request.drivers.map((source) =>
        limit(async () => ({
          result: await reporting(request.update, source.id, () =>
            memoizedDriverListing(request, source),
          ),
          source,
        })),
      ),
    ),
  ]);

  const truncatedSources: TruncatedSkillSource[] = [];
  for (const { result, source } of directoryResults) {
    notes.push(...result.diagnostics.map((diagnostic) => diagnostic.message));
    if (result.status.kind === "unavailable") {
      unavailableSources.push({ hint: result.status.hint, id: source.id, name: source.name });
      continue;
    }
    if (result.truncation !== undefined) {
      truncatedSources.push({ ...result.truncation, id: source.id, name: source.name });
    }
    entries.push(...remoteEntries(result.listings, source));
  }
  for (const { result, source } of driverResults) {
    notes.push(...result.messages);
    if (result.status === "unavailable") {
      unavailableSources.push({
        hint: "could not be listed in this run",
        id: source.id,
        name: source.name,
      });
      continue;
    }
    request.listedDriverSkills.set(source.id, new Set(result.listings.map(({ id }) => id)));
    entries.push(...remoteEntries(result.listings, source));
  }

  notes.push(...packOutcome.notes);
  return {
    entries: Object.freeze(entries),
    notes: Object.freeze(notes),
    packs: packOutcome.groups,
    truncatedSources: Object.freeze(truncatedSources),
    unavailableSources: Object.freeze(unavailableSources),
    ...verificationFields(directoryResults),
  };
}

function verificationFields(
  results: readonly {
    readonly result: Awaited<ReturnType<typeof listDirectorySkills>>;
    readonly source: DirectorySkillSource;
  }[],
): { readonly verification?: SkillCatalogVerification | undefined } {
  const checks = results.flatMap(({ result, source }) =>
    result.verification === undefined ? [] : [{ source, verification: result.verification }],
  );
  if (checks.length === 0) {
    return {};
  }
  const identities = new Map(
    results.flatMap(({ result, source }) =>
      result.listings.map((listing) => [
        skillIdentity(source.id, listing.id),
        { id: listing.id, verification: result.verification },
      ]),
    ),
  );
  return {
    verification: Object.freeze({
      isMissing: (identity: string) => {
        const candidate = identities.get(identity);
        return candidate?.verification?.isMissing(candidate.id) === true;
      },
      settled: Promise.all(checks.map(({ verification }) => verification.settled)).then(
        () => undefined,
      ),
      subscribe: (listener: () => void) => {
        const unsubscribe = checks.map(({ verification }) => verification.subscribe(listener));
        return () => {
          for (const stop of unsubscribe) {
            stop();
          }
        };
      },
    }),
  };
}

/** Keeps the loading row honest even when the listing throws or the memo is already settled. */
async function reporting<T>(
  update: SkillSourceLoadUpdate | undefined,
  id: string,
  load: () => Promise<T>,
): Promise<T> {
  update?.(id, "active");
  try {
    return await load();
  } finally {
    update?.(id, "complete");
  }
}

/** One `list` call per driver per run, shared across every approval set and back-navigation. */
function memoizedDriverListing(
  request: SkillListingRequest,
  source: DriverSkillSource,
): Promise<DriverSkillListingResult> {
  const existing = request.driverListings.get(source.id);
  if (existing !== undefined) {
    return existing;
  }
  const listing = listDriverSkills(request.inputs.environment, source);
  request.driverListings.set(source.id, listing);
  return listing;
}

function bundledEntries(inputs: SkillCatalogInputs): readonly SkillCatalogEntry[] {
  return (inputs.model.availableSkills ?? [])
    .filter((skill) => isSkillSourceAllowed(inputs.preset, skill.source.id))
    .map((skill) => ({
      description: skill.description,
      id: skill.id,
      identity: skillIdentity(skill.source.id, skill.id),
      name: skill.name,
      preview: skill.files.find((file) => file.path === "SKILL.md")?.content,
      remote: false,
      sourceId: skill.source.id,
      sourceName: skill.source.name,
      version: skill.version,
    }));
}

/**
 * One remote row per listing, differing only in what its origin URL means.
 *
 * For a directory the origin is where the bytes were fetched from, falling back to the catalog's
 * own URL when the index named nothing more specific. A driver instead hands Aura a local
 * directory, so its origin is the one the driver *declares* for the content — attributed to the
 * driver at the review rather than presented as a host Aura observed serving it.
 */
function remoteEntries(
  listings: readonly {
    readonly description: string;
    readonly id: string;
    readonly name: string;
    readonly originUrl?: string | undefined;
    readonly version: string;
  }[],
  source: DirectorySkillSource | DriverSkillSource,
): readonly SkillCatalogEntry[] {
  const fallbackUrl = source.kind === "driver" ? undefined : source.url;
  return listings.map((listing) => ({
    description: listing.description,
    id: listing.id,
    identity: skillIdentity(source.id, listing.id),
    name: listing.name,
    remote: true,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: listing.originUrl ?? fallbackUrl,
    version: listing.version,
  }));
}
