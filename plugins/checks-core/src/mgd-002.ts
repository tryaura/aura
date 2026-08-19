import { join } from "node:path";

import {
  defineCheck,
  type AuraManifestSkill,
  type AuraManifestSnippet,
  type DetectedFinding,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { managedContentRevisionStatus, sharedSkillsRoot } from "@tryaura/core";

import { managedContentUpdateChoices } from "./mgd-002-fixes.js";

const CHECK_ID = "MGD-002";

export const managedContentUpdateCheck = defineCheck({
  defaultSeverity: "info",
  detect: detectManagedContentUpdates,
  explain:
    "Aura records the exact version and content hash of each managed snippet and skill. When an installed plugin offers a different revision, Aura reports it and waits for a reviewed change instead of silently replacing managed content. A revision that is not newer — a rollback, or one this build cannot order — is reported too, because Aura keeps the recorded revision either way and an unreported hold would look like nothing to do. Pinned selections remain quiet until they are unpinned.\n\nRun `aura check --fix --interactive` to review bundled revisions and vanished snippets. Locally edited content must be resolved first; directory-sourced skill updates stay in `aura setup`, where network and credential approval are explicit.",
  fix: () => undefined,
  fixability: "guided",
  guidedFixes: managedContentUpdateChoices,
  id: CHECK_ID,
  scope: "global",
  title: "Managed snippets and skills are at their reviewed source revisions",
});

function detectManagedContentUpdates(model: WorkspaceModel): readonly DetectedFinding[] {
  if (model.manifest.status !== "ready") {
    return [];
  }
  return [
    ...model.manifest.value.snippets.flatMap((snippet) => snippetFinding(snippet, model)),
    ...model.manifest.value.skills.flatMap((skill) => skillFinding(skill, model)),
  ];
}

function snippetFinding(
  installed: AuraManifestSnippet,
  model: WorkspaceModel,
): readonly DetectedFinding[] {
  if (installed.pinned) {
    return [];
  }
  const available = model.availableSnippets.find((snippet) => snippet.id === installed.id);
  if (available === undefined) {
    return [
      {
        id: `snippet:${installed.id}:missing`,
        message: `Managed snippet ${installed.id} at version ${installed.version} is no longer provided by an installed plugin.`,
        metadata: { contentId: installed.id, kind: "snippet-missing" },
      },
    ];
  }
  const status = managedContentRevisionStatus(
    installed.version,
    installed.hash,
    available.version,
    available.hash,
  );
  if (status === "current") {
    return [];
  }
  if (status === "diverged") {
    return [
      {
        details:
          "Aura keeps the recorded revision because the offered one is not newer. Re-run `aura setup` interactively to switch to it deliberately, or pin this snippet to stop the comparison.",
        id: `snippet:${installed.id}:diverged`,
        message: `Managed snippet ${installed.id} is recorded at version ${installed.version}, but the installed plugin offers ${available.version}, which is not newer.`,
        metadata: {
          availableVersion: available.version,
          contentId: installed.id,
          installedVersion: installed.version,
          kind: "snippet-diverged",
        },
      },
    ];
  }
  return [
    {
      id: `snippet:${installed.id}:update`,
      message: `Managed snippet ${installed.id} can update from version ${installed.version} to ${available.version}.`,
      metadata: {
        availableVersion: available.version,
        contentId: installed.id,
        installedVersion: installed.version,
        kind: "snippet-update",
      },
    },
  ];
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
