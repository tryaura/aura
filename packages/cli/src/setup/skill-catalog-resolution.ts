import type { DirectorySkillSource, Environment, ResolvedSkillPack } from "@tryaura/aura-sdk";
import { createLimiter, resolveDirectorySkills } from "@tryaura/core";

import type { SkillResolution } from "./skills-catalog.js";
import { skillIdentity } from "./skill-planner-paths.js";
import type { SkillSelection } from "./types.js";

/** How many sources are fetched from at once; each source batches its own skills internally. */
const MAX_CONCURRENT_SOURCE_FETCHES = 4;

/** Fetches what is not already memoized, one directory request batch per source. */
export async function resolveSkillSelections(
  environment: Environment,
  sources: readonly DirectorySkillSource[],
  selections: readonly SkillSelection[],
  packs: Map<string, ResolvedSkillPack>,
  failures: Map<string, string>,
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
  await Promise.all(
    [...bySource.entries()].map(([sourceId, ids]) =>
      limit(async () => {
        const source = sources.find((candidate) => candidate.id === sourceId);
        if (source === undefined) {
          for (const id of ids) {
            unavailable.set(skillIdentity(sourceId, id), "its source is not available in this run");
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
    ),
  );

  return { problems: new Map([...failures, ...unavailable]), resolved: new Map(packs) };
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
