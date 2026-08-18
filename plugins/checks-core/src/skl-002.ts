import { planSkillDeployment, skillDeploymentStatus } from "@tryaura/core";
import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

export const skl002 = defineCheck({
  defaultSeverity: "warn",
  detect: detectDeploymentParity,
  explain:
    "Every skill selected in the Aura manifest is deployed to every declared skills directory of each managed application that supports Agent Skills. A missing deployment makes the selected skill unavailable in that application.\n\nAura creates or repairs only links it can identify as pointing into the shared skills directory.",
  fix: deploymentFix,
  fixability: "auto",
  id: "SKL-002",
  scope: "global",
  title: "Managed applications deploy manifest skills",
});

function detectDeploymentParity(model: WorkspaceModel): readonly DetectedFinding[] {
  if (model.manifest.status !== "ready") {
    return [];
  }
  const manifest = model.manifest.value;
  return model.apps.flatMap((app) => {
    if (
      app.synthetic === true ||
      app.capabilities?.skills === undefined ||
      manifest.apps[app.adapterId]?.managed !== true
    ) {
      return [];
    }
    return manifest.skills.flatMap((skill) => deploymentFindings(app, model, skill.id));
  });
}

function deploymentFindings(
  app: AppModel,
  model: WorkspaceModel,
  skillId: string,
): readonly DetectedFinding[] {
  return (app.skillDirectories ?? []).flatMap((directory) => {
    const status = skillDeploymentStatus(app, directory, skillId);
    if (status?.pathKind === "symlink" && status.resolvedPath === undefined) {
      return [];
    }
    const outcome = planSkillDeployment(app, model, skillId, directory.id);
    if (outcome.kind === "planned" && outcome.plan.operations.length === 0) {
      return [];
    }
    return [
      {
        ...(outcome.kind === "blocked" ? { details: outcome.reason, fixability: "manual" } : {}),
        id: `${app.adapterId}:${directory.id}:${skillId}`,
        locations: [{ path: outcome.path }],
        message: `Shared skill "${skillId}" is not deployed to ${app.displayName} at ${outcome.path}.`,
        metadata: { appId: app.adapterId, directoryId: directory.id, skillId },
      },
    ];
  });
}

function deploymentFix(finding: Finding, model: WorkspaceModel): FixPlan | undefined {
  const appId = finding.metadata?.["appId"];
  const directoryId = finding.metadata?.["directoryId"];
  const skillId = finding.metadata?.["skillId"];
  if (typeof appId !== "string" || typeof directoryId !== "string" || typeof skillId !== "string") {
    return undefined;
  }
  const app = model.apps.find((candidate) => candidate.adapterId === appId);
  if (app === undefined) {
    return undefined;
  }
  const outcome = planSkillDeployment(app, model, skillId, directoryId);
  return outcome.kind === "planned" ? outcome.plan : undefined;
}
