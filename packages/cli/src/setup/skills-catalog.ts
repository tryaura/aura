import type {
  AuraTeamPreset,
  DirectorySkillSource,
  Environment,
  PrivateDirectorySkillSource,
  ResolvedSkillPack,
  SkillSourceId,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  collectSkillDirectorySources,
  createLimiter,
  isSkillSourceAllowed,
  listDirectorySkills,
  type DirectorySkillListingResult,
} from "@tryaura/core";

import { resolveSkillSelections } from "./skill-catalog-resolution.js";
import { skillIdentity } from "./skill-planner-paths.js";
import type { SkillSelection } from "./types.js";

/** How many skill directories the picker lists at once; each is one loading row on screen. */
const MAX_CONCURRENT_SOURCE_LISTINGS = 4;

/** The allowlist in force, in the shape the planner can enforce synchronously. */
export interface SkillSourcePolicy {
  /** Permitted source ids; absent means every source is allowed. */
  readonly allowedSourceIds?: ReadonlySet<string> | undefined;
  /**
   * How refusals name the preset that decided them.
   *
   * The origin as resolved, not the conventional path: a policy fetched from a package or a URL
   * that introduced itself as the local checkout file would be asking for the wrong trust.
   */
  readonly presetName: string;
}

/** One installable row of the skills picker. */
export interface SkillCatalogEntry {
  readonly description: string;
  readonly id: string;
  /** Stable per-run key: source id and local id, as the planner derives it. */
  readonly identity: string;
  readonly name: string;
  /** Full SKILL.md for the `p` overlay; present only for locally bundled skills. */
  readonly preview?: string | undefined;
  /** Whether installing needs a directory fetch — and therefore the review stage. */
  readonly remote: boolean;
  readonly sourceId: SkillSourceId;
  readonly sourceName: string;
  /** Where a remote skill comes from, shown at the review decision point. */
  readonly sourceUrl?: string | undefined;
  readonly version: string;
}

/** A directory that cannot be listed right now, rendered as a disabled picker row. */
export interface UnavailableSkillSource {
  readonly hint: string;
  readonly id: SkillSourceId;
  readonly name: string;
}

export interface SkillCatalogListing {
  readonly entries: readonly SkillCatalogEntry[];
  /** First-visit `io.note` lines: preset problems, index problems, listing failures. */
  readonly notes: readonly string[];
  readonly unavailableSources: readonly UnavailableSkillSource[];
}

export interface SkillResolution {
  /** Identity → why its pack could not be fetched; the review renders it on a disabled row. */
  readonly problems: ReadonlyMap<string, string>;
  /** Identity → the fetched pack, memoized for the run. */
  readonly resolved: ReadonlyMap<string, ResolvedSkillPack>;
}

/** One remote source whose listing request has not been memoized for this approval set. */
export interface PendingSkillSource {
  readonly id: SkillSourceId;
  readonly name: string;
}

type SkillSourceLoadStatus = "active" | "complete";
type SkillSourceLoadUpdate = (id: string, status: SkillSourceLoadStatus) => void;

/**
 * The skills the run can install, resolved on demand.
 *
 * The scan stays offline; only this catalog talks to skill directories, and only when the skills
 * step actually renders or reviews. Listings and packs are memoized so back-navigation and
 * re-planning never refetch.
 */
export interface SkillCatalog {
  readonly load: (
    approvedPrivateSourceIds?: ReadonlySet<string>,
    update?: SkillSourceLoadUpdate,
  ) => Promise<SkillCatalogListing>;
  /** Sources that would perform network I/O if `load` were called with this approval set now. */
  readonly pendingSources: (
    approvedPrivateSourceIds?: ReadonlySet<string>,
  ) => readonly PendingSkillSource[];
  readonly policy: SkillSourcePolicy;
  /** Private sources that require an explicit connection decision before any credential is read. */
  readonly privateSources: readonly PrivateDirectorySkillSource[];
  readonly resolve: (
    selections: readonly SkillSelection[],
    approvedPrivateSourceIds?: ReadonlySet<string>,
  ) => Promise<SkillResolution>;
}

export interface SkillCatalogInputs {
  readonly environment: Environment;
  readonly model: WorkspaceModel;
  readonly preset: AuraTeamPreset | undefined;
  /** Messages from reading the preset file, surfaced with the catalog's own notes. */
  readonly presetNotes: readonly string[];
  /** Where the active policy came from. Defaults to the conventional checkout path. */
  readonly presetOrigin?: string | undefined;
  readonly registryDirectories: readonly DirectorySkillSource[];
}

export function createSkillCatalog(inputs: SkillCatalogInputs): SkillCatalog {
  const collected = collectSkillDirectorySources(inputs.registryDirectories, inputs.preset);
  const packs = new Map<string, ResolvedSkillPack>();
  const failures = new Map<string, string>();
  const pending = new Map<string, Promise<SkillCatalogListing>>();

  return {
    load: (approvedPrivateSourceIds = new Set(), update) => {
      const key = approvalKey(approvedPrivateSourceIds);
      const existing = pending.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const approved = collected.sources.filter(
        (source) => source.kind !== "private-directory" || approvedPrivateSourceIds.has(source.id),
      );
      const unapproved = collected.sources.filter(
        (source): source is PrivateDirectorySkillSource =>
          source.kind === "private-directory" && !approvedPrivateSourceIds.has(source.id),
      );
      const listing = loadListing(
        inputs,
        approved,
        [...inputs.presetNotes, ...collected.diagnostics.map((diagnostic) => diagnostic.message)],
        unapproved,
        update,
      );
      pending.set(key, listing);
      return listing;
    },
    pendingSources: (approvedPrivateSourceIds = new Set()) => {
      if (pending.has(approvalKey(approvedPrivateSourceIds))) {
        return [];
      }
      return collected.sources
        .filter(
          (source) =>
            source.kind !== "private-directory" || approvedPrivateSourceIds.has(source.id),
        )
        .map((source) => ({ id: source.id, name: source.name }));
    },
    policy: {
      ...(inputs.preset?.allowedSkillSources === undefined
        ? {}
        : { allowedSourceIds: new Set<string>(inputs.preset.allowedSkillSources) }),
      presetName: inputs.presetOrigin ?? AURA_TEAM_PRESET_PATH,
    },
    privateSources: Object.freeze(
      collected.sources.filter(
        (source): source is PrivateDirectorySkillSource => source.kind === "private-directory",
      ),
    ),
    resolve: (selections, approvedPrivateSourceIds = new Set()) =>
      resolveSkillSelections(
        inputs.environment,
        collected.sources.filter(
          (source) =>
            source.kind !== "private-directory" || approvedPrivateSourceIds.has(source.id),
        ),
        selections,
        packs,
        failures,
      ),
  };
}

async function loadListing(
  inputs: SkillCatalogInputs,
  sources: readonly DirectorySkillSource[],
  baseNotes: readonly string[],
  unapproved: readonly PrivateDirectorySkillSource[],
  update: SkillSourceLoadUpdate | undefined,
): Promise<SkillCatalogListing> {
  const entries: SkillCatalogEntry[] = [];
  const notes = [...baseNotes];
  const unavailableSources: UnavailableSkillSource[] = unapproved.map((source) => ({
    hint: `connection not approved; token ${source.tokenEnv}`,
    id: source.id,
    name: source.name,
  }));

  for (const skill of inputs.model.availableSkills ?? []) {
    if (!isSkillSourceAllowed(inputs.preset, skill.source.id)) {
      continue;
    }
    entries.push({
      description: skill.description,
      id: skill.id,
      identity: skillIdentity(skill.source.id, skill.id),
      name: skill.name,
      preview: skill.files.find((file) => file.path === "SKILL.md")?.content,
      remote: false,
      sourceId: skill.source.id,
      sourceName: skill.source.name,
      version: skill.version,
    });
  }

  const limit = createLimiter(MAX_CONCURRENT_SOURCE_LISTINGS);
  const listings: readonly {
    readonly result: DirectorySkillListingResult;
    readonly source: DirectorySkillSource;
  }[] = await Promise.all(
    sources.map((source) =>
      limit(async () => {
        update?.(source.id, "active");
        try {
          return {
            result: await listDirectorySkills(inputs.environment, source),
            source,
          };
        } finally {
          update?.(source.id, "complete");
        }
      }),
    ),
  );
  for (const { result, source } of listings) {
    notes.push(...result.diagnostics.map((diagnostic) => diagnostic.message));
    if (result.status.kind === "unavailable") {
      unavailableSources.push({ hint: result.status.hint, id: source.id, name: source.name });
      continue;
    }
    for (const listing of result.listings) {
      entries.push({
        description: listing.description,
        id: listing.id,
        identity: skillIdentity(source.id, listing.id),
        name: listing.name,
        remote: true,
        sourceId: source.id,
        sourceName: source.name,
        // The host that serves the bytes, not the catalog that advertised them: a directory that
        // indexes content elsewhere names the real origin, and that is what the review shows.
        sourceUrl: listing.originUrl ?? source.url,
        version: listing.version,
      });
    }
  }

  return {
    entries: Object.freeze(entries),
    notes: Object.freeze(notes),
    unavailableSources: Object.freeze(unavailableSources),
  };
}

function approvalKey(approvedPrivateSourceIds: ReadonlySet<string>): string {
  return [...approvedPrivateSourceIds].sort().join("\0");
}
