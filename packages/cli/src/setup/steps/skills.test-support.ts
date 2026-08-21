import type {
  AuraManifestSkill,
  AuraManifestState,
  PrivateDirectorySkillSource,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";
import type { SkillPackGroup } from "@tryaura/core";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import { skillIdentity } from "../skill-planner-paths.js";
import type { AppCatalogEntry } from "../catalog.js";
import type {
  PendingSkillSource,
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogVerification,
  TruncatedSkillSource,
  UnavailableSkillSource,
} from "../skills-catalog.js";
import { emptyMcpCatalog, emptySkillCatalog } from "../testing.js";
import type { SetupStepContext } from "../types.js";
import { createScriptedWizardIo, type ScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardAnswers, WizardQuestion } from "../wizard-types.js";

export const HASH_1 = "1".repeat(64);
export const HASH_2 = "2".repeat(64);
export const REMOTE_IDENTITY = skillIdentity("directory:acme", "review");
export const BUNDLED_IDENTITY = skillIdentity("plugin:official", "review");

export const REMOTE_ENTRY: SkillCatalogEntry = {
  description: "Review changes before landing.",
  id: "review",
  identity: REMOTE_IDENTITY,
  name: "Review",
  remote: true,
  sourceId: "directory:acme",
  sourceName: "Acme Skills",
  sourceUrl: "https://skills.acme.example",
  version: "1.0.0",
};

export const PRIVATE_SOURCE: PrivateDirectorySkillSource = {
  id: "directory:acme",
  kind: "private-directory",
  name: "Acme Skills",
  tokenEnv: "ACME_SKILLS_TOKEN",
  url: "https://skills.acme.example",
};

export function remotePack(treeHash: string): ResolvedSkillPack {
  return {
    description: "Review changes before landing.",
    files: [{ content: "# Review skill\n", path: "SKILL.md" }],
    id: "review",
    name: "Review",
    source: {
      id: "directory:acme",
      kind: "directory",
      name: "Acme Skills",
      url: "https://skills.acme.example",
    },
    treeHash,
    version: "1.0.0",
  };
}

export function bundledPack(treeHash: string, version = "1.0.0"): ResolvedSkillPack {
  return {
    description: "Review changes before landing.",
    files: [{ content: "# Review skill\n", path: "SKILL.md" }],
    id: "review",
    name: "Review",
    source: { id: "plugin:official", kind: "bundled", name: "Official" },
    treeHash,
    version,
  };
}

export const REPO_IDENTITY = skillIdentity("repo:workspace", "release-runbook");

export function repoPack(treeHash: string, version = "1.0.0"): ResolvedSkillPack {
  return {
    description: "Cut a release.",
    files: [{ content: "# Release runbook\n", path: "SKILL.md" }],
    id: "release-runbook",
    name: "Release runbook",
    source: {
      id: "repo:workspace",
      kind: "repo",
      name: "This repository",
      path: "/workspace/.aura/skills",
    },
    treeHash,
    version,
  };
}

export function repoEntry(pack: ResolvedSkillPack): SkillCatalogEntry {
  return {
    description: pack.description,
    id: pack.id,
    identity: skillIdentity(pack.source.id, pack.id),
    name: pack.name,
    preview: pack.files.find((file) => file.path === "SKILL.md")?.content,
    remote: false,
    sourceId: pack.source.id,
    sourceName: pack.source.name,
    version: pack.version,
  };
}

interface CatalogOptions {
  readonly entries?: readonly SkillCatalogEntry[];
  readonly notes?: readonly string[];
  readonly packs?: ReadonlyMap<string, ResolvedSkillPack>;
  readonly pendingSources?: readonly PendingSkillSource[];
  readonly policy?: SkillCatalog["policy"];
  readonly privateSources?: readonly PrivateDirectorySkillSource[];
  readonly listingPacks?: readonly SkillPackGroup[];
  readonly problems?: ReadonlyMap<string, string>;
  readonly truncatedSources?: readonly TruncatedSkillSource[];
  readonly unavailableSources?: readonly UnavailableSkillSource[];
  readonly verification?: SkillCatalogVerification | undefined;
}

export function fakeCatalog(options: CatalogOptions = {}): SkillCatalog {
  const listing = {
    entries: options.entries ?? [],
    notes: options.notes ?? [],
    packs: options.listingPacks ?? [],
    truncatedSources: options.truncatedSources ?? [],
    unavailableSources: options.unavailableSources ?? [],
    ...(options.verification === undefined ? {} : { verification: options.verification }),
  };
  return {
    load: (_approved, update) => {
      for (const source of options.pendingSources ?? []) {
        update?.(source.id, "active");
        update?.(source.id, "complete");
      }
      return Promise.resolve(listing);
    },
    pendingSources: () => options.pendingSources ?? [],
    policy: options.policy ?? emptySkillCatalog().policy,
    privateSources: options.privateSources ?? [],
    resolve: () =>
      Promise.resolve({
        problems: options.problems ?? new Map(),
        resolved: options.packs ?? new Map(),
      }),
  };
}

export function skillStepContext(
  catalog: SkillCatalog,
  previous: readonly AuraManifestSkill[] = [],
  options: SkillStepContextOptions = {},
): SetupStepContext {
  const manifestAppIds = options.manifestAppIds ?? ["codex"];
  const manifest: AuraManifestState =
    options.manifestMissing === true
      ? { exists: false, path: "/home/dev/agents/aura.json", status: "missing" }
      : {
          exists: true,
          mode: 0o600,
          path: "/home/dev/agents/aura.json",
          status: "ready",
          value: {
            apps: Object.fromEntries(manifestAppIds.map((id) => [id, { managed: true }])),
            mcpServers: [],
            ownership: {},
            schemaVersion: 1,
            skills: previous,
            snippets: [],
          },
        };
  return {
    appCatalog: options.appCatalog ?? [supportedApp("codex", "Codex")],
    interactive: false,
    isEnvironmentVariableSet: () => false,
    manifest,
    mcpCatalog: emptyMcpCatalog(),
    model: createWorkspaceModel({
      availableSkills: options.availableSkills ?? [],
      manifest,
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    }),
    ...(options.presetSkills === undefined
      ? {}
      : {
          preset: {
            checkSummary: [],
            explicit: true,
            name: "Fixture preset",
            reference: "plugin:fixture/onboarding",
            skills: options.presetSkills,
            snippets: [],
          },
        }),
    ...(options.repo === undefined
      ? {}
      : {
          repoPreset: {
            accepted: true,
            checkSummary: [],
            contentSet: { mcpServers: [], skills: options.repo.skills, snippets: [] },
            hash: "f".repeat(64),
            path: "/workspace/.aura/preset.json",
            preset: {
              schemaVersion: 1 as const,
              ...(options.repo.selected === undefined ? {} : { skills: options.repo.selected }),
            },
            recorded: true,
            status: "applied" as const,
          },
        }),
    selections:
      options.selectedAppIds === undefined
        ? options.manifestMissing === true
          ? { apps: { managed: manifestAppIds } }
          : {}
        : { apps: { managed: options.selectedAppIds } },
    skillCatalog: catalog,
    snippetCatalog: {
      entries: () => [],
      load: () => Promise.resolve([]),
    },
  };
}

interface SkillStepContextOptions {
  readonly appCatalog?: readonly AppCatalogEntry[];
  readonly availableSkills?: readonly ResolvedSkillPack[];
  readonly manifestAppIds?: readonly string[];
  readonly manifestMissing?: boolean;
  readonly presetSkills?: NonNullable<SetupStepContext["preset"]>["skills"];
  /** Applied repository preset content: skill trees plus the selections it makes by default. */
  readonly repo?:
    | {
        readonly selected?: NonNullable<SetupStepContext["preset"]>["skills"] | undefined;
        readonly skills: readonly ResolvedSkillPack[];
      }
    | undefined;
  readonly selectedAppIds?: readonly string[];
}

export function supportedApp(adapterId: string, displayName: string): AppCatalogEntry {
  return { adapterId, displayName, kind: "undetected", supportsMcp: false, supportsSkills: true };
}

export function unsupportedApp(adapterId: string, displayName: string): AppCatalogEntry {
  return { adapterId, displayName, kind: "undetected", supportsMcp: false, supportsSkills: false };
}

export interface RecordingIo extends ScriptedWizardIo {
  readonly asked: readonly WizardQuestion[][];
}

export function recordingIo(forms: readonly WizardAnswers[]): RecordingIo {
  const base = createScriptedWizardIo({ forms });
  const asked: WizardQuestion[][] = [];
  return {
    ...base,
    ask: (questions, flow) => {
      asked.push([...questions]);
      return base.ask(questions, flow);
    },
    asked,
  };
}
