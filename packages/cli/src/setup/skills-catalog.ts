import type {
  AuraTeamPreset,
  DirectorySkillSource,
  DriverSkillSource,
  Environment,
  PrivateDirectorySkillSource,
  ResolvedSkillPack,
  SkillSourceId,
  SkillSourceDriver,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  collectSkillDirectorySources,
  isSkillSourceAllowed,
  type DriverSkillListingResult,
} from "@tryaura/core";

import { resolveSkillSelections } from "./skill-catalog-resolution.js";
import { loadListing } from "./skills-catalog-listing.js";
import type { SkillSelection } from "./types.js";

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
  /** Advisory background checks that can disable stale rows while the picker is open. */
  readonly verification?: SkillCatalogVerification | undefined;
}

export interface SkillCatalogVerification {
  readonly isMissing: (identity: string) => boolean;
  readonly settled: Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
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
export type SkillSourceLoadUpdate = (id: string, status: SkillSourceLoadStatus) => void;

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
  /**
   * Whether this run may call a skill-source driver at all.
   *
   * Required rather than defaulted: a driver is the one source kind that runs plugin code, and a
   * caller that simply forgot the flag would silently ship a catalog with every driver missing and
   * nothing on screen to say so.
   */
  readonly interactive: boolean;
  readonly model: WorkspaceModel;
  readonly preset: AuraTeamPreset | undefined;
  /** Messages from reading the preset file, surfaced with the catalog's own notes. */
  readonly presetNotes: readonly string[];
  /** Where the active policy came from. Defaults to the conventional checkout path. */
  readonly presetOrigin?: string | undefined;
  readonly registryDirectories: readonly DirectorySkillSource[];
  readonly registryDrivers?: readonly SkillSourceDriver[] | undefined;
}

export function createSkillCatalog(inputs: SkillCatalogInputs): SkillCatalog {
  const collected = collectSkillDirectorySources(inputs.registryDirectories, inputs.preset);
  const packs = new Map<string, ResolvedSkillPack>();
  const failures = new Map<string, string>();
  const pending = new Map<string, Promise<SkillCatalogListing>>();
  const driverListings = new Map<string, Promise<DriverSkillListingResult>>();
  const listedDriverSkills = new Map<string, Set<string>>();
  const drivers: readonly DriverSkillSource[] = inputs.interactive
    ? (inputs.registryDrivers ?? [])
        .map((driver): DriverSkillSource => ({
          driver,
          id: `driver:${driver.id}`,
          kind: "driver",
          name: driver.name,
        }))
        .filter((source) => isSkillSourceAllowed(inputs.preset, source.id))
    : [];

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
      const listing = loadListing({
        driverListings,
        drivers,
        inputs,
        listedDriverSkills,
        notes: [
          ...inputs.presetNotes,
          ...collected.diagnostics.map((diagnostic) => diagnostic.message),
        ],
        sources: approved,
        unapproved,
        update,
      });
      pending.set(key, listing);
      return listing;
    },
    pendingSources: (approvedPrivateSourceIds = new Set()) => {
      if (pending.has(approvalKey(approvedPrivateSourceIds))) {
        return [];
      }
      return [
        ...collected.sources
          .filter(
            (source) =>
              source.kind !== "private-directory" || approvedPrivateSourceIds.has(source.id),
          )
          .map((source) => ({ id: source.id, name: source.name })),
        ...drivers
          .filter((source) => !driverListings.has(source.id))
          .map((source) => ({ id: source.id, name: source.name })),
      ];
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
        drivers,
        listedDriverSkills,
      ),
  };
}

function approvalKey(approvedPrivateSourceIds: ReadonlySet<string>): string {
  return [...approvedPrivateSourceIds].sort().join("\0");
}
