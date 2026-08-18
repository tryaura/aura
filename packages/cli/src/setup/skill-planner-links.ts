import { dirname, join, resolve } from "node:path";

import type { AdapterFileStatus, FileOperation } from "@tryaura/aura-sdk";
import { planSkillDeployment } from "@tryaura/core";

import { managedAppIdList } from "./managed-apps.js";
import type { SetupStepContext } from "./types.js";

/** The mutable slices of a skill plan the link planner appends to. */
export interface SkillPlanBuffers {
  readonly manualSteps: string[];
  readonly operations: FileOperation[];
}

export function sharedRoot(context: SetupStepContext): string {
  return join(context.model.homeDir, "agents", "skills");
}

export function planLinks(id: string, context: SetupStepContext, state: SkillPlanBuffers): void {
  for (const app of managedApps(context)) {
    for (const directory of app.skillDirectories ?? []) {
      const outcome = planSkillDeployment(app, context.model, id, directory.id, {
        assumeShared: true,
      });
      if (outcome.kind === "blocked") {
        state.manualSteps.push(outcome.reason);
      } else {
        state.operations.push(...outcome.plan.operations);
      }
    }
  }
}

export function planLinkRemoval(
  id: string,
  context: SetupStepContext,
  operations: FileOperation[],
): void {
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
  const managed = new Set(managedAppIdList(context));
  return context.model.apps.filter((app) => app.synthetic !== true && managed.has(app.adapterId));
}
