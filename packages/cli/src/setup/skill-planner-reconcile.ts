import { join } from "node:path";

import type {
  AuraManifestSkill,
  FileOperation,
  ResolvedSkillPack,
  SharedSkillState,
} from "@tryaura/aura-sdk";
import { planSharedSkillTreeUpdate } from "@tryaura/core";

import type { SetupBlocker, SetupNotice } from "./planner.js";
import { planLinks, planLinkRemoval, sharedRoot } from "./skill-planner-links.js";
import { removeSkillEntries } from "./skill-planner-paths.js";
import type { SetupStepContext, SkillSelection } from "./types.js";

/** The slices of a skill plan each reconcile step appends to. */
export interface MutableSkillPlan {
  readonly blockers: SetupBlocker[];
  readonly manifestSkills: AuraManifestSkill[];
  readonly manualSteps: string[];
  readonly notices: SetupNotice[];
  readonly operations: FileOperation[];
}

/** The manifest row one resolved pack becomes. */
function manifestSkill(skill: ResolvedSkillPack): AuraManifestSkill {
  return {
    id: skill.id,
    pinned: false,
    source: skill.source.id,
    treeHash: skill.treeHash,
    version: skill.version,
  };
}

/**
 * What the source offers for one selection, and whether this run may apply it.
 *
 * `held` is carried alongside the pack rather than replacing it with `undefined`, because "you
 * declined this revision" and "no source provides this skill" need different messages and
 * different recovery: only the first can name the version that is waiting.
 */
export interface OfferedRevision {
  readonly available: ResolvedSkillPack | undefined;
  readonly held: boolean;
}

// fallow-ignore-next-line complexity -- the branches are the explicit provenance safety states.
export function reconcileSelection(
  selection: SkillSelection,
  previousIdentity: AuraManifestSkill | undefined,
  previousAtId: AuraManifestSkill | undefined,
  offered: OfferedRevision,
  shared: SharedSkillState | undefined,
  context: SetupStepContext,
  state: MutableSkillPlan,
): void {
  const previous = previousIdentity ?? previousAtId;
  if (previous?.pinned === true && previousIdentity !== undefined) {
    preserveOrRestore(previous, offered.available, shared, context, state);
    return;
  }
  if (offered.held && previousIdentity !== undefined) {
    keepRecordedRevision(previousIdentity, offered.available, shared, context, state);
    return;
  }
  const available = offered.available;
  if (available === undefined) {
    if (previousIdentity !== undefined) {
      preserveOrRestore(previousIdentity, undefined, shared, context, state);
    } else {
      state.blockers.push({
        path: join(sharedRoot(context), selection.id),
        reason: `Skill "${selection.id}" from ${selection.source} is unavailable in this build.`,
      });
    }
    return;
  }

  const desired = manifestSkill(available);
  if (shared !== undefined && previous !== undefined && shared.treeHash !== previous.treeHash) {
    state.manifestSkills.push(previous);
    state.manualSteps.push(
      `Review the local edits in ${shared.path} before updating skill "${selection.id}"; Aura left its files and provenance unchanged.`,
    );
    planLinks(previous.id, context, state);
    return;
  }
  if (shared !== undefined && previous === undefined && shared.treeHash !== desired.treeHash) {
    state.blockers.push({
      path: shared.path,
      reason: `A skill directory already exists for "${selection.id}" but the manifest does not own it. Move or remove it before installing this selection.`,
    });
    return;
  }

  state.manifestSkills.push(desired);
  if (shared?.treeHash !== desired.treeHash) {
    planTreeReplacement(shared, available, context, state.operations);
  }
  planLinks(selection.id, context, state);
}

/**
 * Keeps a skill at the revision the manifest records after its update went unreviewed.
 *
 * A missing shared tree is the one case that cannot simply be left alone: the recorded revision is
 * gone from disk and the only pack on hand is the newer one the user declined, so the step says
 * exactly that instead of reporting the skill as unavailable or as pinned.
 */
function keepRecordedRevision(
  previous: AuraManifestSkill,
  available: ResolvedSkillPack | undefined,
  shared: SharedSkillState | undefined,
  context: SetupStepContext,
  state: MutableSkillPlan,
): void {
  state.manifestSkills.push(previous);
  state.notices.push({
    kind: "held",
    message:
      `${previous.id} stays at ${previous.version}; ${available?.version ?? "a new revision"} is ` +
      "available. Run setup interactively to review it.",
  });
  if (shared === undefined) {
    state.manualSteps.push(
      `Skill "${previous.id}" stays at version ${previous.version}, but its files are missing ` +
        `from ${join(sharedRoot(context), previous.id)}. Re-run setup and accept version ` +
        `${available?.version ?? "the available revision"}, or reinstall the recorded revision ` +
        "from its source.",
    );
  } else if (shared.treeHash !== previous.treeHash) {
    state.manualSteps.push(
      `Review the local edits in ${shared.path} before updating skill "${previous.id}"; Aura left its files and provenance unchanged.`,
    );
  }
  planLinks(previous.id, context, state);
}

function preserveOrRestore(
  previous: AuraManifestSkill,
  available: ResolvedSkillPack | undefined,
  shared: SharedSkillState | undefined,
  context: SetupStepContext,
  state: MutableSkillPlan,
): void {
  state.manifestSkills.push(previous);
  if (shared === undefined) {
    if (available?.treeHash === previous.treeHash) {
      planTreeReplacement(undefined, available, context, state.operations);
    } else {
      state.manualSteps.push(
        `Reinstall pinned skill "${previous.id}" at version ${previous.version}; its recorded source tree is unavailable.`,
      );
    }
  }
  planLinks(previous.id, context, state);
}

export function reconcileRemoval(
  previous: AuraManifestSkill,
  shared: SharedSkillState | undefined,
  context: SetupStepContext,
  state: MutableSkillPlan,
): void {
  if (shared !== undefined && shared.treeHash !== previous.treeHash) {
    state.manifestSkills.push(previous);
    state.manualSteps.push(
      `Review the local edits in ${shared.path} before removing skill "${previous.id}"; Aura kept its files, links, and provenance.`,
    );
    return;
  }
  planLinkRemoval(previous.id, context, state.operations);
  if (shared !== undefined) {
    state.operations.push(...removeSkillEntries(shared.entries));
  }
}

function planTreeReplacement(
  shared: SharedSkillState | undefined,
  desired: ResolvedSkillPack,
  context: SetupStepContext,
  operations: FileOperation[],
): void {
  const root = join(sharedRoot(context), desired.id);
  operations.push(...planSharedSkillTreeUpdate(root, shared?.entries ?? [], desired));
}
