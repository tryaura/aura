import type {
  AuraManifestSkill,
  Finding,
  GuidedFixChoice,
  ResolvedSkillPack,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createAuraManifestWriteOperation, planSharedSkillTreeUpdate } from "@tryaura/core";

export function managedSkillUpdateChoices(
  finding: Finding,
  model: WorkspaceModel,
): readonly GuidedFixChoice[] {
  const kind = finding.metadata?.["kind"];
  return finding.checkId === "MGD-002" && (kind === "skill-update" || kind === "skill-diverged")
    ? skillUpdateChoices(finding, model)
    : [];
}

function skillUpdateChoices(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  const context = skillUpdateContext(finding, model);
  if (context === undefined) {
    return [];
  }
  if (
    context.shared.problem !== undefined ||
    context.shared.treeHash !== context.installed.treeHash
  ) {
    return [resolveSkillDriftFirst(context.contentId)];
  }
  return [skillUpdateChoice(finding, context)];
}

interface SkillUpdateContext {
  readonly available: ResolvedSkillPack;
  readonly contentId: string;
  readonly installed: AuraManifestSkill;
  readonly manifest: Extract<WorkspaceModel["manifest"], { readonly status: "ready" }>;
  readonly shared: NonNullable<WorkspaceModel["sharedSkills"]>[number];
}

function skillUpdateContext(
  finding: Finding,
  model: WorkspaceModel,
): SkillUpdateContext | undefined {
  const context = readyFindingContext(finding, model);
  const sourceId = finding.metadata?.["sourceId"];
  if (context === undefined || typeof sourceId !== "string") {
    return undefined;
  }
  const { contentId, manifest } = context;
  const installed = manifest.value.skills.find(
    (skill) => skill.id === contentId && skill.source === sourceId,
  );
  const available = model.availableSkills?.find(
    (skill) => skill.id === contentId && skill.source.id === sourceId,
  );
  const shared = model.sharedSkills?.find((skill) => skill.id === contentId);
  return installed === undefined || available === undefined || shared === undefined
    ? undefined
    : { available, contentId, installed, manifest, shared };
}

function skillUpdateChoice(finding: Finding, context: SkillUpdateContext): GuidedFixChoice {
  const { available, contentId, installed, manifest: manifestState, shared } = context;
  const manifest = {
    ...manifestState.value,
    skills: manifestState.value.skills.map((skill) =>
      skill === installed ? updatedSkill(skill, available) : skill,
    ),
  };
  const update = finding.metadata?.["kind"] === "skill-update";
  return {
    id: "update",
    label: `${update ? "Update to" : "Switch to"} ${available.version}`,
    plan: {
      operations: [
        ...planSharedSkillTreeUpdate(shared.path, shared.entries, available),
        createAuraManifestWriteOperation(manifestState, manifest),
      ],
      summary: `Set managed skill ${contentId} to ${available.version}.`,
    },
  };
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
