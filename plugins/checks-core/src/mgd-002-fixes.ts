import type {
  AuraManifestSkill,
  AuraManifestSnippet,
  Finding,
  GuidedFixChoice,
  ResolvedSkillPack,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import {
  createAuraManifestWriteOperation,
  diffManagedSnippet,
  planSharedSkillTreeUpdate,
  reconcileManagedSnippet,
  reconcileParsedManagedBlock,
} from "@tryaura/core";

import { managedDocuments } from "./mgd-001-documents.js";

export function managedContentUpdateChoices(
  finding: Finding,
  model: WorkspaceModel,
): readonly GuidedFixChoice[] {
  if (finding.checkId !== "MGD-002") {
    return [];
  }
  const kind = finding.metadata?.["kind"];
  if (kind === "snippet-update" || kind === "snippet-diverged") {
    return snippetUpdateChoices(finding, model);
  }
  if (kind === "snippet-missing") {
    return missingSnippetChoices(finding, model);
  }
  return kind === "skill-update" || kind === "skill-diverged"
    ? skillUpdateChoices(finding, model)
    : [];
}

/**
 * How a choice names the revision it would apply.
 *
 * A diverged revision is a deliberate move to content that is not newer, so calling it an update
 * would misdescribe what the user is accepting.
 */
function applyLabel(finding: Finding, version: string): string {
  return `${finding.metadata?.["kind"] === "snippet-update" || finding.metadata?.["kind"] === "skill-update" ? "Update to" : "Switch to"} ${version}`;
}

// fallow-ignore-next-line complexity -- update safety requires every managed-block anchor.
function snippetUpdateChoices(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  const context = readyFindingContext(finding, model);
  if (context === undefined) {
    return [];
  }
  const { contentId, manifest: manifestState } = context;
  const installed = manifestState.value.snippets.find((snippet) => snippet.id === contentId);
  const available = model.availableSnippets.find((snippet) => snippet.id === contentId);
  const located = locateManagedSnippet(model, contentId);
  if (installed === undefined || available === undefined || located === undefined) {
    return [];
  }
  if (!located.snippet.hashMatches || located.snippet.computedHash !== installed.hash) {
    return [resolveDriftFirst(contentId)];
  }
  const reconciled = reconcileManagedSnippet(located.document.content, contentId, {
    content: available.content,
    kind: "restore",
  });
  if (reconciled.status === "invalid") {
    return [resolveDriftFirst(contentId)];
  }
  const manifest = {
    ...manifestState.value,
    snippets: manifestState.value.snippets.map((snippet) =>
      snippet === installed
        ? { ...snippet, hash: available.hash, pinned: false, version: available.version }
        : snippet,
    ),
  };
  return [
    {
      details: () =>
        diffManagedSnippet(located.document.path, located.snippet.content, available.content),
      id: "update",
      label: applyLabel(finding, available.version),
      plan: {
        operations: [
          { content: reconciled.content, path: located.document.path, type: "write" },
          createAuraManifestWriteOperation(manifestState, manifest),
        ],
        summary: `Set managed snippet ${contentId} to ${available.version}.`,
      },
    },
  ];
}

function missingSnippetChoices(
  finding: Finding,
  model: WorkspaceModel,
): readonly GuidedFixChoice[] {
  const context = readyFindingContext(finding, model);
  if (context === undefined) {
    return [];
  }
  const { contentId, manifest } = context;
  const installed = manifest.value.snippets.find((snippet) => snippet.id === contentId);
  if (installed === undefined) {
    return [];
  }
  const pinnedManifest = {
    ...manifest.value,
    snippets: manifest.value.snippets.map((snippet) =>
      snippet === installed ? { ...snippet, pinned: true } : snippet,
    ),
  };
  const choices: GuidedFixChoice[] = [
    {
      id: "pin",
      label: "Keep as pinned",
      plan: {
        operations: [createAuraManifestWriteOperation(manifest, pinnedManifest)],
        summary: `Keep unavailable snippet ${contentId} at its installed revision.`,
      },
    },
  ];
  const removal = removeSnippetPlan(model, contentId, installed);
  if (removal !== undefined) {
    choices.push({ id: "remove", label: "Remove", plan: removal });
  }
  return choices;
}

function removeSnippetPlan(
  model: WorkspaceModel,
  contentId: string,
  installed: AuraManifestSnippet,
): GuidedFixChoice["plan"] | undefined {
  if (model.manifest.status !== "ready") {
    return undefined;
  }
  const located = locateManagedSnippet(model, contentId);
  if (located === undefined) {
    return undefined;
  }
  const preserve =
    located.document.parsed.status === "present"
      ? located.document.parsed.block.snippets
          .map((snippet) => snippet.id)
          .filter((id) => id !== contentId)
      : [];
  const reconciled = reconcileParsedManagedBlock(
    located.document.content,
    located.document.parsed,
    [],
    {
      ownedSnippetIds: model.manifest.value.snippets.map((snippet) => snippet.id),
      preserveSnippetIds: preserve,
      previousSnippetHashes: new Map(
        model.manifest.value.snippets.map((snippet) => [snippet.id, snippet.hash]),
      ),
    },
  );
  if (reconciled.status === "invalid") {
    return undefined;
  }
  const manifest = {
    ...model.manifest.value,
    snippets: model.manifest.value.snippets.filter((snippet) => snippet !== installed),
  };
  return {
    operations: [
      { content: reconciled.content, path: located.document.path, type: "write" },
      createAuraManifestWriteOperation(model.manifest, manifest),
    ],
    summary: `Remove unavailable managed snippet ${contentId}.`,
  };
}

// fallow-ignore-next-line complexity -- update safety requires every provenance and local anchor.
function skillUpdateChoices(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  const context = readyFindingContext(finding, model);
  const sourceId = finding.metadata?.["sourceId"];
  if (context === undefined || typeof sourceId !== "string") {
    return [];
  }
  const { contentId, manifest: manifestState } = context;
  const installed = manifestState.value.skills.find(
    (skill) => skill.id === contentId && skill.source === sourceId,
  );
  const available = model.availableSkills?.find(
    (skill) => skill.id === contentId && skill.source.id === sourceId,
  );
  const shared = model.sharedSkills?.find((skill) => skill.id === contentId);
  if (installed === undefined || available === undefined || shared === undefined) {
    return [];
  }
  if (shared.problem !== undefined || shared.treeHash !== installed.treeHash) {
    return [resolveSkillDriftFirst(contentId)];
  }
  const manifest = {
    ...manifestState.value,
    skills: manifestState.value.skills.map((skill) =>
      skill === installed ? updatedSkill(skill, available) : skill,
    ),
  };
  return [
    {
      id: "update",
      label: applyLabel(finding, available.version),
      plan: {
        operations: [
          ...planSharedSkillTreeUpdate(shared.path, shared.entries, available),
          createAuraManifestWriteOperation(manifestState, manifest),
        ],
        summary: `Set managed skill ${contentId} to ${available.version}.`,
      },
    },
  ];
}

function readyFindingContext(
  finding: Finding,
  model: WorkspaceModel,
):
  | {
      readonly contentId: string;
      readonly manifest: Extract<WorkspaceModel["manifest"], { readonly status: "ready" }>;
    }
  | undefined {
  const contentId = finding.metadata?.["contentId"];
  return typeof contentId === "string" && model.manifest.status === "ready"
    ? { contentId, manifest: model.manifest }
    : undefined;
}

function updatedSkill(
  installed: AuraManifestSkill,
  available: ResolvedSkillPack,
): AuraManifestSkill {
  return {
    ...installed,
    pinned: false,
    treeHash: available.treeHash,
    version: available.version,
  };
}

function locateManagedSnippet(model: WorkspaceModel, contentId: string) {
  for (const document of managedDocuments(model)) {
    if (document.parsed.status !== "present") {
      continue;
    }
    const snippet = document.parsed.block.snippets.find((candidate) => candidate.id === contentId);
    if (snippet !== undefined) {
      return { document, snippet };
    }
  }
  return undefined;
}

function resolveDriftFirst(contentId: string): GuidedFixChoice {
  return {
    id: "resolve-drift",
    label: "Resolve local edits first",
    plan: {
      manualSteps: [
        `Run \`aura check --only MGD-001 --fix --interactive\` and resolve edits to ${contentId}, then review this update again.`,
      ],
      operations: [],
      summary: `Resolve local edits to ${contentId} before updating it.`,
    },
  };
}

function resolveSkillDriftFirst(contentId: string): GuidedFixChoice {
  return {
    id: "resolve-drift",
    label: "Review local edits first",
    plan: {
      manualSteps: [
        `Review the locally changed shared skill ${contentId}; pin or reconcile it before applying the source update.`,
      ],
      operations: [],
      summary: `Review local edits to skill ${contentId} before updating it.`,
    },
  };
}
