import type {
  DirectorySkillSource,
  DriverSkillSource,
  Environment,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";
import { createLimiter, resolveDirectorySkills, resolveDriverSkills } from "@tryaura/core";

import type { SkillResolution } from "./skills-catalog.js";
import { skillIdentity } from "./skill-planner-paths.js";
import type { SkillSelection } from "./types.js";

/** How many sources are fetched from at once; each source batches its own skills internally. */
const MAX_CONCURRENT_SOURCE_FETCHES = 4;

interface ResolutionContext {
  readonly directories: readonly DirectorySkillSource[];
  readonly drivers: readonly DriverSkillSource[];
  readonly environment: Environment;
  readonly failures: Map<string, string>;
  readonly listedDriverSkills: ReadonlyMap<string, ReadonlySet<string>>;
  readonly packs: Map<string, ResolvedSkillPack>;
  readonly unavailable: Map<string, string>;
}

/** Fetches what is not already memoized, one directory request batch per source. */
export async function resolveSkillSelections(
  environment: Environment,
  sources: readonly DirectorySkillSource[],
  selections: readonly SkillSelection[],
  packs: Map<string, ResolvedSkillPack>,
  failures: Map<string, string>,
  drivers: readonly DriverSkillSource[],
  listedDriverSkills: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<SkillResolution> {
  const bySource = new Map<string, string[]>();
  const unavailable = new Map<string, string>();
  for (const selection of selections) {
    const identity = skillIdentity(selection.source, selection.id);
    if (packs.has(identity) || failures.has(identity)) {
      continue;
    }
    const ids = bySource.get(selection.source) ?? [];
    ids.push(selection.id);
    bySource.set(selection.source, ids);
  }

  const limit = createLimiter(MAX_CONCURRENT_SOURCE_FETCHES);
  const context: ResolutionContext = {
    directories: sources,
    drivers,
    environment,
    failures,
    listedDriverSkills,
    packs,
    unavailable,
  };
  await Promise.all(
    [...bySource.entries()].map(([sourceId, ids]) =>
      limit(() => resolveSourceBatch(context, sourceId, ids)),
    ),
  );

  return { problems: new Map([...failures, ...unavailable]), resolved: new Map(packs) };
}

// fallow-ignore-next-line complexity -- one batch isolates directory and driver result protocols.
async function resolveSourceBatch(
  context: ResolutionContext,
  sourceId: string,
  ids: readonly string[],
): Promise<void> {
  const directory = context.directories.find((candidate) => candidate.id === sourceId);
  const driver = context.drivers.find((candidate) => candidate.id === sourceId);
  if (directory === undefined && driver === undefined) {
    for (const id of ids) {
      context.unavailable.set(
        skillIdentity(sourceId, id),
        "its source is not available in this run",
      );
    }
    return;
  }
  // A driver only ever resolves what it advertised: an id the listing did not carry was never sent
  // to it, so the batches below run over `eligibleIds` and the skipped ones keep the reason they
  // were given here rather than being retold as a fetch that failed.
  const listed = context.listedDriverSkills.get(sourceId);
  const eligibleIds = driver === undefined ? ids : ids.filter((id) => listed?.has(id) === true);
  const eligible = new Set(eligibleIds);
  for (const id of ids) {
    if (!eligible.has(id)) {
      context.failures.set(skillIdentity(sourceId, id), "was not listed by its source in this run");
    }
  }
  if (eligibleIds.length === 0) {
    return;
  }
  if (driver === undefined) {
    if (directory === undefined) {
      return;
    }
    const result = await resolveDirectorySkills(context.environment, directory, eligibleIds);
    record(context, sourceId, eligibleIds, result.skills, (id) =>
      resolutionFailure(result.diagnostics, id),
    );
    return;
  }
  const result = await resolveDriverSkills(context.environment, driver, eligibleIds);
  record(
    context,
    sourceId,
    eligibleIds,
    result.skills,
    (id) => result.problems.get(id) ?? "could not be fetched from its driver",
  );
}

/** Memoizes one batch's packs, then explains every requested id the batch did not return. */
function record(
  context: ResolutionContext,
  sourceId: string,
  requestedIds: readonly string[],
  skills: readonly ResolvedSkillPack[],
  failure: (id: string) => string,
): void {
  for (const skill of skills) {
    context.packs.set(skillIdentity(sourceId, skill.id), skill);
  }
  for (const id of requestedIds) {
    const identity = skillIdentity(sourceId, id);
    if (!context.packs.has(identity)) {
      context.failures.set(identity, failure(id));
    }
  }
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
