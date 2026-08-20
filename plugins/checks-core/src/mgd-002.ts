import { join } from "node:path";

import {
  defineCheck,
  type AuraManifestSkill,
  type DetectedFinding,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { managedContentRevisionStatus, sharedSkillsRoot } from "@tryaura/core";

import { managedSkillUpdateChoices } from "./mgd-002-fixes.js";

export const managedContentUpdateCheck = defineCheck({
  defaultSeverity: "info",
  detect: detectManagedSkillUpdates,
  explain:
    "Aura records the exact source revision of each managed skill. When an installed plugin offers a different revision, Aura reports it and waits for a reviewed change instead of silently replacing the skill. Pinned skills remain quiet until they are unpinned.\n\nRun `aura check --fix` to review bundled skill revisions. Directory-sourced skill updates stay in `aura setup`, where network and credential approval are explicit.",
  fix: () => undefined,
  fixability: "guided",
  guidedFixes: managedSkillUpdateChoices,
  id: "MGD-002",
  scope: "global",
  title: "Managed skills are at their reviewed source revisions",
});

function detectManagedSkillUpdates(model: WorkspaceModel): readonly DetectedFinding[] {
  return model.manifest.status === "ready"
    ? model.manifest.value.skills.flatMap((skill) => skillFinding(skill, model))
    : [];
}

function skillFinding(
  installed: AuraManifestSkill,
  model: WorkspaceModel,
): readonly DetectedFinding[] {
  if (installed.pinned || !installed.source.startsWith("plugin:")) {
    return [];
  }
  const available = model.availableSkills?.find(
    (skill) => skill.id === installed.id && skill.source.id === installed.source,
  );
  if (available === undefined) {
    return [];
  }
  const status = managedContentRevisionStatus(
    installed.version,
    installed.treeHash,
    available.version,
    available.treeHash,
  );
  if (status === "current") {
    return [];
  }
  const location = { path: join(sharedSkillsRoot(model.homeDir), installed.id) };
  if (status === "diverged") {
    return [
      {
        details:
          "Aura keeps the recorded revision because the offered one is not newer. Re-run `aura setup` interactively to switch to it deliberately, or pin this skill to stop the comparison.",
        id: `skill:${installed.source}:${installed.id}:diverged`,
        locations: [location],
        message: `Managed skill ${installed.id} is recorded at version ${installed.version}, but the installed plugin offers ${available.version}, which is not newer.`,
        metadata: {
          availableVersion: available.version,
          contentId: installed.id,
          installedVersion: installed.version,
          kind: "skill-diverged",
          sourceId: installed.source,
        },
      },
    ];
  }
  return [
    {
      id: `skill:${installed.source}:${installed.id}:update`,
      locations: [location],
      message: `Managed skill ${installed.id} can update from version ${installed.version} to ${available.version}.`,
      metadata: {
        availableVersion: available.version,
        contentId: installed.id,
        installedVersion: installed.version,
        kind: "skill-update",
        sourceId: installed.source,
      },
    },
  ];
}
