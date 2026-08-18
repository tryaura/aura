import type {
  AuraTeamPreset,
  DirectorySkillSource,
  Environment,
  ResolvedSkillPack,
  SkillSourceId,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  collectSkillDirectorySources,
  isSkillSourceAllowed,
  listDirectorySkills,
  resolveDirectorySkills,
  type DirectorySkillListingResult,
} from "@tryaura/core";

import { skillIdentity } from "./skill-planner-paths.js";
import type { SkillSelection } from "./types.js";

/** The allowlist in force, in the shape the planner can enforce synchronously. */
export interface SkillSourcePolicy {
  /** Permitted source ids; absent means every source is allowed. */
  readonly allowedSourceIds?: ReadonlySet<string> | undefined;
  /** How refusals name the preset that decided them. */
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

/**
 * The skills the run can install, resolved on demand.
 *
 * The scan stays offline; only this catalog talks to skill directories, and only when the skills
 * step actually renders or reviews. Listings and packs are memoized so back-navigation and
 * re-planning never refetch.
 */
export interface SkillCatalog {
  readonly load: () => Promise<SkillCatalogListing>;
  readonly policy: SkillSourcePolicy;
  readonly resolve: (selections: readonly SkillSelection[]) => Promise<SkillResolution>;
}

export interface SkillCatalogInputs {
  readonly environment: Environment;
  readonly model: WorkspaceModel;
  readonly preset: AuraTeamPreset | undefined;
  /** Messages from reading the preset file, surfaced with the catalog's own notes. */
  readonly presetNotes: readonly string[];
  readonly registryDirectories: readonly DirectorySkillSource[];
}

export function createSkillCatalog(inputs: SkillCatalogInputs): SkillCatalog {
  const collected = collectSkillDirectorySources(inputs.registryDirectories, inputs.preset);
  const packs = new Map<string, ResolvedSkillPack>();
  const failures = new Map<string, string>();
  let pending: Promise<SkillCatalogListing> | undefined;

  return {
    load: () => {
      pending ??= loadListing(inputs, collected.sources, [
        ...inputs.presetNotes,
        ...collected.diagnostics.map((diagnostic) => diagnostic.message),
      ]);
      return pending;
    },
    policy: {
      ...(inputs.preset?.allowedSkillSources === undefined
        ? {}
        : { allowedSourceIds: new Set<string>(inputs.preset.allowedSkillSources) }),
      presetName: AURA_TEAM_PRESET_PATH,
    },
    resolve: (selections) =>
      resolveSelections(inputs.environment, collected.sources, selections, packs, failures),
  };
}

async function loadListing(
  inputs: SkillCatalogInputs,
  sources: readonly DirectorySkillSource[],
  baseNotes: readonly string[],
): Promise<SkillCatalogListing> {
  const entries: SkillCatalogEntry[] = [];
  const notes = [...baseNotes];
  const unavailableSources: UnavailableSkillSource[] = [];

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

  const listings: readonly {
    readonly result: DirectorySkillListingResult;
    readonly source: DirectorySkillSource;
  }[] = await Promise.all(
    sources.map(async (source) => ({
      result: await listDirectorySkills(inputs.environment, source),
      source,
    })),
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
        sourceUrl: source.url,
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

/** Fetches what is not already memoized, one directory request batch per source. */
async function resolveSelections(
  environment: Environment,
  sources: readonly DirectorySkillSource[],
  selections: readonly SkillSelection[],
  packs: Map<string, ResolvedSkillPack>,
  failures: Map<string, string>,
): Promise<SkillResolution> {
  const bySource = new Map<string, string[]>();
  for (const selection of selections) {
    const identity = skillIdentity(selection.source, selection.id);
    if (packs.has(identity) || failures.has(identity)) {
      continue;
    }
    const ids = bySource.get(selection.source) ?? [];
    ids.push(selection.id);
    bySource.set(selection.source, ids);
  }

  await Promise.all(
    [...bySource.entries()].map(async ([sourceId, ids]) => {
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) {
        for (const id of ids) {
          failures.set(skillIdentity(sourceId, id), "its source is not available in this run");
        }
        return;
      }
      const result = await resolveDirectorySkills(environment, source, ids);
      for (const skill of result.skills) {
        packs.set(skillIdentity(sourceId, skill.id), skill);
      }
      for (const id of ids) {
        const identity = skillIdentity(sourceId, id);
        if (!packs.has(identity)) {
          failures.set(identity, resolutionFailure(result.diagnostics, id));
        }
      }
    }),
  );

  return { problems: new Map(failures), resolved: new Map(packs) };
}

function resolutionFailure(
  diagnostics: readonly { readonly message: string }[],
  id: string,
): string {
  return (
    diagnostics.find((diagnostic) => diagnostic.message.includes(`"${id}"`))?.message ??
    "could not be fetched from its directory"
  );
}
