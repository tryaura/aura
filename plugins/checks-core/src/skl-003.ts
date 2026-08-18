import { isAuraOwnedSkillTarget, sharedSkillsRoot } from "@tryaura/core";
import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type InstalledSkill,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { join } from "node:path";

export const skl003 = defineCheck({
  defaultSeverity: "error",
  detect: detectBrokenSymlinks,
  explain:
    "A dangling skill symlink cannot be loaded by its application. The link can be repaired when its shared copy still exists, or removed when the manifest no longer claims it.\n\nAura changes only links whose target lies inside Aura's shared skills directory; foreign links remain user-owned.",
  fix: brokenLinkFix,
  fixability: "auto",
  id: "SKL-003",
  scope: "global",
  title: "Application skill symlinks resolve",
});

function detectBrokenSymlinks(model: WorkspaceModel): readonly DetectedFinding[] {
  return model.skills.flatMap((skill) => brokenLinkFinding(skill, model));
}

function brokenLinkFinding(
  skill: InstalledSkill,
  model: WorkspaceModel,
): readonly DetectedFinding[] {
  const action = brokenLinkAction(skill, model);
  if (action === "healthy") {
    return [];
  }
  if (action === "foreign") {
    return [
      {
        details:
          "The link points outside Aura's shared skills directory, so Aura treats it as user-owned and will not change it.",
        fixability: "manual",
        id: `${skill.appId}:${skill.sourceId ?? "skills"}:${skill.id}`,
        locations: [{ path: skill.path }],
        message: `Skill link ${skill.path} points to a missing foreign target.`,
        metadata: { action: "foreign", appId: skill.appId, skillId: skill.id },
      },
    ];
  }
  return [
    {
      ...(action === "reinstall"
        ? {
            details: `The manifest still claims skill "${skill.id}". Reinstall it with aura setup instead of removing its deployment link.`,
            fixability: "manual",
          }
        : {}),
      id: `${skill.appId}:${skill.sourceId ?? "skills"}:${skill.id}`,
      locations: [{ path: skill.path }],
      message: `Skill link ${skill.path} has a missing target.`,
      metadata: { action, appId: skill.appId, skillId: skill.id },
    },
  ];
}

type BrokenLinkAction = "foreign" | "healthy" | "reinstall" | "relink" | "remove";

function brokenLinkAction(skill: InstalledSkill, model: WorkspaceModel): BrokenLinkAction {
  const target = skill.symlinkTargetPath;
  if (target === undefined || skill.symlinkResolvedPath !== undefined) {
    return "healthy";
  }
  if (!isAuraOwnedSkillTarget(model.homeDir, target)) {
    return "foreign";
  }
  if (model.sharedSkills?.some((shared) => shared.id === skill.id) === true) {
    return "relink";
  }
  const claimed =
    model.manifest.status === "ready" &&
    model.manifest.value.skills.some((manifestSkill) => manifestSkill.id === skill.id);
  return claimed ? "reinstall" : "remove";
}

function brokenLinkFix(finding: Finding, model: WorkspaceModel): FixPlan | undefined {
  const action = finding.metadata?.["action"];
  const skillId = finding.metadata?.["skillId"];
  const path = finding.locations?.[0]?.path;
  if (typeof action !== "string" || typeof skillId !== "string" || path === undefined) {
    return undefined;
  }
  if (action === "remove") {
    return {
      operations: [{ path, type: "remove" }],
      summary: `Remove the unclaimed dangling skill link for "${skillId}".`,
    };
  }
  if (action === "relink") {
    return {
      operations: [
        { path, target: join(sharedSkillsRoot(model.homeDir), skillId), type: "symlink" },
      ],
      summary: `Repair the shared skill link for "${skillId}".`,
    };
  }
  return undefined;
}
