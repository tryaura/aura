import type { AuraManifestSkill, FileOperation, ResolvedSkillPack } from "@tryaura/aura-sdk";

import type { SetupBlocker, SetupNotice } from "./planner.js";
import { sharedRoot } from "./skill-planner-links.js";
import { skillIdentity } from "./skill-planner-paths.js";
import { disallowedSkillBlockers } from "./skill-planner-policy.js";
import {
  reconcileRemoval,
  reconcileSelection,
  type MutableSkillPlan,
  type OfferedRevision,
} from "./skill-planner-reconcile.js";
import type { SetupStepContext, SkillSelection } from "./types.js";

export interface SkillPlan {
  readonly blockers: readonly SetupBlocker[];
  readonly manifestSkills: readonly AuraManifestSkill[];
  readonly manualSteps: readonly string[];
  /** What the plan deliberately did not do, for the summary to say out loud. */
  readonly notices: readonly SetupNotice[];
  readonly operations: readonly FileOperation[];
}

export function planSkills(context: SetupStepContext): SkillPlan {
  const previous = context.manifest.status === "ready" ? context.manifest.value.skills : [];
  const selected = context.selections.skills?.selected ?? previous.map(toSelection);
  const duplicate = duplicateLocalId(selected);
  if (duplicate !== undefined) {
    return abandoned(previous, {
      path: sharedRoot(context),
      reason: `Skill "${duplicate}" was selected from more than one source. Choose one source for each installed skill ID.`,
    });
  }
  const disallowed = disallowedSkillBlockers(
    selected,
    context.skillCatalog.policy,
    sharedRoot(context),
  );
  if (disallowed.length > 0) {
    return {
      blockers: disallowed,
      manifestSkills: previous,
      manualSteps: [],
      notices: [],
      operations: [],
    };
  }

  const state: MutableSkillPlan = {
    blockers: [],
    manifestSkills: [],
    manualSteps: [],
    notices: [],
    operations: [],
  };
  // Remote packs the step fetched and reviewed extend the bundled catalog; the scan never
  // fetches, so this is the only route a directory skill takes into the plan.
  const catalog = new Map(
    [...(context.model.availableSkills ?? []), ...(context.selections.skills?.resolved ?? [])].map(
      (skill) => [skillIdentity(skill.source.id, skill.id), skill],
    ),
  );
  const previousByIdentity = new Map(
    previous.map((skill) => [skillIdentity(skill.source, skill.id), skill]),
  );
  const previousById = new Map(previous.map((skill) => [skill.id, skill]));
  const acceptedUpdates = new Set(context.selections.skills?.updates ?? []);
  const sharedById = new Map((context.model.sharedSkills ?? []).map((skill) => [skill.id, skill]));

  for (const selection of selected) {
    const identity = skillIdentity(selection.source, selection.id);
    const previousAtIdentity = previousByIdentity.get(identity);
    reconcileSelection(
      selection,
      previousAtIdentity,
      previousById.get(selection.id),
      offeredRevision(previousAtIdentity, catalog.get(identity), acceptedUpdates.has(identity)),
      sharedById.get(selection.id),
      context,
      state,
    );
  }

  const desiredIds = new Set(selected.map((selection) => selection.id));
  for (const skill of previous) {
    if (!desiredIds.has(skill.id)) {
      reconcileRemoval(skill, sharedById.get(skill.id), context, state);
    }
  }

  return {
    blockers: Object.freeze(state.blockers),
    manifestSkills: Object.freeze(state.manifestSkills),
    manualSteps: Object.freeze(state.manualSteps),
    notices: Object.freeze(state.notices),
    operations: Object.freeze(state.operations),
  };
}

function offeredRevision(
  previous: AuraManifestSkill | undefined,
  available: ResolvedSkillPack | undefined,
  accepted: boolean,
): OfferedRevision {
  const held =
    previous !== undefined &&
    available !== undefined &&
    previous.treeHash !== available.treeHash &&
    !accepted;
  return { available, held };
}

function abandoned(previous: readonly AuraManifestSkill[], blocker: SetupBlocker): SkillPlan {
  return {
    blockers: [blocker],
    manifestSkills: previous,
    manualSteps: [],
    notices: [],
    operations: [],
  };
}

function duplicateLocalId(selected: readonly SkillSelection[]): string | undefined {
  const seen = new Set<string>();
  for (const skill of selected) {
    if (seen.has(skill.id)) {
      return skill.id;
    }
    seen.add(skill.id);
  }
  return undefined;
}

function toSelection(skill: AuraManifestSkill): SkillSelection {
  return { id: skill.id, source: skill.source };
}
