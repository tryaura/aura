import { dirname, join, resolve } from "node:path";

import type {
  AdapterFileStatus,
  AuraManifestSkill,
  FileOperation,
  ResolvedSkillPack,
  SharedSkillState,
} from "@tryaura/aura-sdk";

import type { SetupBlocker } from "./planner.js";
import { isStrictDescendant, removeSkillEntries, skillIdentity } from "./skill-planner-paths.js";
import type { SetupStepContext, SkillSelection } from "./types.js";

export interface SkillPlan {
  readonly blockers: readonly SetupBlocker[];
  readonly manifestSkills: readonly AuraManifestSkill[];
  readonly manualSteps: readonly string[];
  readonly operations: readonly FileOperation[];
}

export function planSkills(context: SetupStepContext): SkillPlan {
  const previous = context.manifest.status === "ready" ? context.manifest.value.skills : [];
  const selected = context.selections.skills?.selected ?? previous.map(toSelection);
  const duplicate = duplicateLocalId(selected);
  if (duplicate !== undefined) {
    return {
      blockers: [
        {
          path: sharedRoot(context),
          reason: `Skill "${duplicate}" was selected from more than one source. Choose one source for each installed skill ID.`,
        },
      ],
      manifestSkills: previous,
      manualSteps: [],
      operations: [],
    };
  }

  const state: MutableSkillPlan = {
    blockers: [],
    manifestSkills: [],
    manualSteps: [],
    operations: [],
  };
  const catalog = new Map(
    (context.model.availableSkills ?? []).map((skill) => [
      skillIdentity(skill.source.id, skill.id),
      skill,
    ]),
  );
  const previousByIdentity = new Map(
    previous.map((skill) => [skillIdentity(skill.source, skill.id), skill]),
  );
  const previousById = new Map(previous.map((skill) => [skill.id, skill]));
  const sharedById = new Map((context.model.sharedSkills ?? []).map((skill) => [skill.id, skill]));

  for (const selection of selected) {
    reconcileSelection(
      selection,
      previousByIdentity.get(skillIdentity(selection.source, selection.id)),
      previousById.get(selection.id),
      catalog.get(skillIdentity(selection.source, selection.id)),
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
    operations: Object.freeze(state.operations),
  };
}

interface MutableSkillPlan {
  readonly blockers: SetupBlocker[];
  readonly manifestSkills: AuraManifestSkill[];
  readonly manualSteps: string[];
  readonly operations: FileOperation[];
}

// fallow-ignore-next-line complexity -- the branches are the explicit provenance safety states.
function reconcileSelection(
  selection: SkillSelection,
  previousIdentity: AuraManifestSkill | undefined,
  previousAtId: AuraManifestSkill | undefined,
  available: ResolvedSkillPack | undefined,
  shared: SharedSkillState | undefined,
  context: SetupStepContext,
  state: MutableSkillPlan,
): void {
  const previous = previousIdentity ?? previousAtId;
  if (previous?.pinned === true && previousIdentity !== undefined) {
    preserveOrRestore(previous, available, shared, context, state);
    return;
  }
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

function reconcileRemoval(
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
  const desiredPaths = new Set(desired.files.map((file) => resolve(root, ...file.path.split("/"))));
  if (shared !== undefined) {
    operations.push(
      ...removeSkillEntries(
        shared.entries.filter(
          (entry) =>
            !desiredPaths.has(resolve(entry.path)) &&
            (entry.kind !== "directory" ||
              ![...desiredPaths].some((path) => isStrictDescendant(entry.path, path))),
        ),
      ),
    );
  }
  operations.push(
    ...desired.files.map((file): FileOperation => ({
      content: file.content,
      path: join(root, ...file.path.split("/")),
      type: "write",
    })),
  );
}

function planLinks(id: string, context: SetupStepContext, state: MutableSkillPlan): void {
  const target = join(sharedRoot(context), id);
  for (const { path, status } of skillDeployments(context, id)) {
    if (status === undefined || !status.exists) {
      state.operations.push({ path, target, type: "symlink" });
      continue;
    }
    if (status.pathKind === "symlink" && status.symlinkTarget !== undefined) {
      const actual = resolve(dirname(path), status.symlinkTarget);
      if (actual === resolve(target)) {
        continue;
      }
    }
    state.manualSteps.push(
      `Aura left ${path} unchanged because it is not an Aura-managed skill link. Move it aside to deploy skill "${id}" there.`,
    );
  }
}

function planLinkRemoval(id: string, context: SetupStepContext, operations: FileOperation[]): void {
  const target = resolve(join(sharedRoot(context), id));
  for (const { path, status } of skillDeployments(context, id)) {
    if (
      status?.pathKind === "symlink" &&
      status.symlinkTarget !== undefined &&
      resolve(dirname(path), status.symlinkTarget) === target
    ) {
      operations.push({ path, type: "remove" });
    }
  }
}

interface SkillDeployment {
  readonly path: string;
  readonly status: AdapterFileStatus | undefined;
}

function skillDeployments(context: SetupStepContext, id: string): SkillDeployment[] {
  const deployments: SkillDeployment[] = [];
  for (const app of managedApps(context)) {
    for (const directory of app.skillDirectories ?? []) {
      const path = join(directory.path, id);
      const status = app.sourceFiles.find((file) => resolve(file.spec.path) === resolve(path));
      deployments.push({ path, status });
    }
  }
  return deployments;
}

function managedApps(context: SetupStepContext): SetupStepContext["model"]["apps"] {
  const selected = context.selections.apps?.managed;
  const managed = new Set(
    selected ??
      (context.manifest.status === "ready"
        ? Object.entries(context.manifest.value.apps)
            .filter(([, app]) => app.managed)
            .map(([id]) => id)
        : []),
  );
  return context.model.apps.filter((app) => app.synthetic !== true && managed.has(app.adapterId));
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

function manifestSkill(skill: ResolvedSkillPack): AuraManifestSkill {
  return {
    id: skill.id,
    pinned: false,
    source: skill.source.id,
    treeHash: skill.treeHash,
    version: skill.version,
  };
}

function toSelection(skill: AuraManifestSkill): SkillSelection {
  return { id: skill.id, source: skill.source };
}

function sharedRoot(context: SetupStepContext): string {
  return join(context.model.homeDir, "agents", "skills");
}
