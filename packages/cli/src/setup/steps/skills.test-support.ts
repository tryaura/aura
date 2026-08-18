import type {
  AuraManifestSkill,
  AuraManifestState,
  PrivateDirectorySkillSource,
  ResolvedSkillPack,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import { skillIdentity } from "../skill-planner-paths.js";
import type { AppCatalogEntry } from "../catalog.js";
import type { SkillCatalog, SkillCatalogEntry, UnavailableSkillSource } from "../skills-catalog.js";
import { emptySkillCatalog } from "../testing.js";
import type { SetupStepContext } from "../types.js";
import { createScriptedWizardIo, type ScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardAnswers, WizardQuestion } from "../wizard-types.js";

export const HASH_1 = "1".repeat(64);
export const HASH_2 = "2".repeat(64);
export const REMOTE_IDENTITY = skillIdentity("directory:acme", "review");

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

interface CatalogOptions {
  readonly entries?: readonly SkillCatalogEntry[];
  readonly notes?: readonly string[];
  readonly packs?: ReadonlyMap<string, ResolvedSkillPack>;
  readonly policy?: SkillCatalog["policy"];
  readonly privateSources?: readonly PrivateDirectorySkillSource[];
  readonly problems?: ReadonlyMap<string, string>;
  readonly unavailableSources?: readonly UnavailableSkillSource[];
}

export function fakeCatalog(options: CatalogOptions = {}): SkillCatalog {
  return {
    load: () =>
      Promise.resolve({
        entries: options.entries ?? [],
        notes: options.notes ?? [],
        unavailableSources: options.unavailableSources ?? [],
      }),
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
  const manifest: AuraManifestState = {
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
    manifest,
    model: createWorkspaceModel({
      manifest,
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    }),
    selections:
      options.selectedAppIds === undefined ? {} : { apps: { managed: options.selectedAppIds } },
    skillCatalog: catalog,
    snippetCatalog: {
      entries: () => [],
      load: () => Promise.resolve([]),
    },
  };
}

interface SkillStepContextOptions {
  readonly appCatalog?: readonly AppCatalogEntry[];
  readonly manifestAppIds?: readonly string[];
  readonly selectedAppIds?: readonly string[];
}

export function supportedApp(adapterId: string, displayName: string): AppCatalogEntry {
  return { adapterId, displayName, kind: "undetected", supportsSkills: true };
}

export function unsupportedApp(adapterId: string, displayName: string): AppCatalogEntry {
  return { adapterId, displayName, kind: "undetected", supportsSkills: false };
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
