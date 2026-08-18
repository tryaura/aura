import { join } from "node:path";

import type { SetupBlocker } from "./planner.js";
import type { SkillSourcePolicy } from "./skills-catalog.js";
import type { SkillSelection } from "./types.js";

/**
 * Blockers for selections the team preset does not allow.
 *
 * This runs at the planner choke point, so the full flow, `--add skill`, and `--yes` are all
 * caught — including a manifest entry whose source was allowed when it was installed and is not
 * any more, because the planner's selection fallback is the manifest itself. A blocker exits
 * before anything is written; unchecking the skill in the Skills step is the sanctioned way out.
 */
export function disallowedSkillBlockers(
  selected: readonly SkillSelection[],
  policy: SkillSourcePolicy,
  sharedRoot: string,
): readonly SetupBlocker[] {
  const allowed = policy.allowedSourceIds;
  if (allowed === undefined) {
    return [];
  }
  return selected
    .filter((selection) => !allowed.has(selection.source))
    .map((selection) => ({
      path: join(sharedRoot, selection.id),
      reason:
        `Skill "${selection.id}" comes from ${selection.source}, which the team preset ` +
        `"${policy.presetName}" does not allow. Clear it in the Skills step or update the preset.`,
    }));
}
