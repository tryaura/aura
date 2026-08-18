import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  AdapterFileStatus,
  AppModel,
  FixPlan,
  ResolvedSkillDirectory,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

/** Either a deployment Aura can carry out, or the reason it refuses to touch the path. */
export type SkillDeploymentPlan =
  | { readonly kind: "blocked"; readonly path: string; readonly reason: string }
  | { readonly kind: "planned"; readonly path: string; readonly plan: FixPlan };

/** Plans one manifest skill's link into one adapter-declared directory. */
export function planSkillDeployment(
  app: AppModel,
  model: WorkspaceModel,
  skillId: string,
  directoryId: string,
  options: { readonly assumeShared?: boolean } = {},
): SkillDeploymentPlan {
  const directory = app.skillDirectories?.find((candidate) => candidate.id === directoryId);
  if (directory === undefined) {
    return {
      kind: "blocked",
      path: skillId,
      reason: "The application no longer declares this skills directory.",
    };
  }
  const path = join(directory.path, skillId);
  const target = join(sharedSkillsRoot(model.homeDir), skillId);
  const sharedExists = model.sharedSkills?.some((skill) => skill.id === skillId) === true;
  if (!sharedExists && options.assumeShared !== true) {
    return {
      kind: "blocked",
      path,
      reason: `The shared copy at ${target} is missing. Reinstall skill "${skillId}" before deploying it.`,
    };
  }

  const status = skillDeploymentStatus(app, directory, skillId);
  if (status === undefined || !status.exists) {
    return { kind: "planned", path, plan: symlinkPlan(app, path, target) };
  }
  if (status.problem !== undefined) {
    return {
      kind: "blocked",
      path,
      reason: `Aura could not safely inspect ${path} (${status.problem}) and will not replace it.`,
    };
  }
  if (status.pathKind !== "symlink" || status.symlinkTarget === undefined) {
    return {
      kind: "blocked",
      path,
      reason: `${path} is not an Aura-managed skill link. Move it aside before deploying skill "${skillId}" there.`,
    };
  }

  const actualTarget = absoluteTarget(path, status.symlinkTarget);
  if (actualTarget === resolve(target)) {
    return { kind: "planned", path, plan: convergedPlan(app, skillId) };
  }
  if (!isAuraOwnedSkillTarget(model.homeDir, actualTarget)) {
    return {
      kind: "blocked",
      path,
      reason: `${path} is not an Aura-managed skill link because it points outside Aura's shared skills directory. It was preserved.`,
    };
  }
  return { kind: "planned", path, plan: symlinkPlan(app, path, target) };
}

/** Finds the captured status for one deployed skill path. */
export function skillDeploymentStatus(
  app: AppModel,
  directory: ResolvedSkillDirectory,
  skillId: string,
): AdapterFileStatus | undefined {
  const path = resolve(join(directory.path, skillId));
  return app.sourceFiles.find((file) => resolve(file.spec.path) === path);
}

/** Whether a lexical target lies within Aura's canonical shared skills root. */
export function isAuraOwnedSkillTarget(homeDir: string, targetPath: string): boolean {
  const root = resolve(sharedSkillsRoot(homeDir));
  const target = resolve(targetPath);
  const fromRoot = relative(root, target);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

/** Canonical location Aura uses for shared skill trees. */
export function sharedSkillsRoot(homeDir: string): string {
  return join(homeDir, "agents", "skills");
}

function absoluteTarget(path: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
}

function symlinkPlan(app: AppModel, path: string, target: string): FixPlan {
  return {
    operations: [{ path, target, type: "symlink" }],
    summary: `Deploy the shared skill to ${app.displayName}.`,
  };
}

function convergedPlan(app: AppModel, skillId: string): FixPlan {
  return {
    operations: [],
    summary: `${app.displayName} already loads shared skill "${skillId}".`,
  };
}
