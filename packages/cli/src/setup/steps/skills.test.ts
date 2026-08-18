import type { AuraManifestSkill, AuraManifestState, ResolvedSkillPack } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it } from "vitest";

import { skillIdentity } from "../skill-planner-paths.js";
import type { SkillCatalog, SkillCatalogEntry, UnavailableSkillSource } from "../skills-catalog.js";
import { emptySkillCatalog } from "../testing.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStepContext } from "../types.js";
import { createScriptedWizardIo, type ScriptedWizardIo } from "../wizard-scripted.js";
import type { WizardAnswers, WizardQuestion } from "../wizard-types.js";
import { skillsStep } from "./skills.js";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const REMOTE_IDENTITY = skillIdentity("directory:acme", "review");

const REMOTE_ENTRY: SkillCatalogEntry = {
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

function remotePack(treeHash: string): ResolvedSkillPack {
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
  readonly problems?: ReadonlyMap<string, string>;
  readonly unavailableSources?: readonly UnavailableSkillSource[];
}

function fakeCatalog(options: CatalogOptions = {}): SkillCatalog {
  return {
    load: () =>
      Promise.resolve({
        entries: options.entries ?? [],
        notes: options.notes ?? [],
        unavailableSources: options.unavailableSources ?? [],
      }),
    policy: options.policy ?? emptySkillCatalog().policy,
    resolve: () =>
      Promise.resolve({
        problems: options.problems ?? new Map(),
        resolved: options.packs ?? new Map(),
      }),
  };
}

function context(
  catalog: SkillCatalog,
  previous: readonly AuraManifestSkill[] = [],
): SetupStepContext {
  const manifest: AuraManifestState = {
    exists: true,
    mode: 0o600,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: previous,
      snippets: [],
    },
  };
  return {
    appCatalog: [],
    manifest,
    model: createWorkspaceModel({
      manifest,
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    }),
    selections: {},
    skillCatalog: catalog,
    snippetCatalog: {
      entries: () => [],
      load: () => Promise.resolve([]),
    },
  };
}

interface RecordingIo extends ScriptedWizardIo {
  readonly asked: readonly WizardQuestion[][];
}

function io(forms: readonly WizardAnswers[]): RecordingIo {
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

describe("skillsStep", () => {
  it("returns unchanged selections when nothing is offered or recorded", async () => {
    const scripted = io([]);

    const outcome = await skillsStep.gather(context(fakeCatalog()), scripted);

    expect(outcome).toEqual({});
    expect(scripted.notes).toContain(
      "No skills are available from the installed plugins or directories.",
    );
  });

  it("requires an explicit install through the review before a directory skill lands", async () => {
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
    });
    const scripted = io([
      { skills: { kind: "options", values: [REMOTE_IDENTITY] } },
      { [`review:${REMOTE_IDENTITY}`]: { kind: "options", values: ["install"] } },
    ]);

    const outcome = await skillsStep.gather(context(catalog), scripted);

    expect(outcome).toEqual({
      skills: {
        resolved: [remotePack(HASH_1)],
        selected: [{ id: "review", source: "directory:acme" }],
      },
    });
    const review = scripted.asked[1]?.[0];
    expect(review?.initial).toEqual(["skip"]);
    expect(review?.options[1]?.preview).toBe("# Review skill\n");
    expect(review?.options[1]?.description).toBe("https://skills.acme.example");
  });

  it("drops a newly selected directory skill when its review defaults to skip", async () => {
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
    });
    // The picker answer checks the skill; the exhausted script leaves the review at its default.
    const scripted = io([{ skills: { kind: "options", values: [REMOTE_IDENTITY] } }]);

    const outcome = await skillsStep.gather(context(catalog), scripted);

    // Nothing survives the skipped review and nothing was recorded, so the slice stays absent.
    expect(outcome).toEqual({});
  });

  it("never first-installs under defaults: manifest-only initial, reviews skip", async () => {
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
    });
    const scripted = io([]);

    const outcome = await skillsStep.gather(context(catalog), scripted);

    // Nothing recorded, so defaults select nothing, no review runs, and no slice is written.
    expect(outcome).toEqual({});
    expect(scripted.asked).toHaveLength(1);
  });

  it("re-applies an unchanged manifest-recorded skill without a review", async () => {
    const previous: AuraManifestSkill = {
      id: "review",
      pinned: false,
      source: "directory:acme",
      treeHash: HASH_1,
      version: "1.0.0",
    };
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
    });
    const scripted = io([]);

    const outcome = await skillsStep.gather(context(catalog, [previous]), scripted);

    expect(outcome).toEqual({
      skills: {
        resolved: [remotePack(HASH_1)],
        selected: [{ id: "review", source: "directory:acme" }],
      },
    });
    expect(scripted.asked).toHaveLength(1);
  });

  it("keeps the installed version when an upstream update's review defaults to skip", async () => {
    const previous: AuraManifestSkill = {
      id: "review",
      pinned: false,
      source: "directory:acme",
      treeHash: HASH_1,
      version: "1.0.0",
    };
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_2)]]),
    });
    const scripted = io([]);

    const outcome = await skillsStep.gather(context(catalog, [previous]), scripted);

    expect(outcome).toEqual({
      skills: { resolved: [], selected: [{ id: "review", source: "directory:acme" }] },
    });
    const review = scripted.asked[1]?.[0];
    expect(review?.prompt).toContain("Update");
    expect(review?.options[0]?.label).toBe("Skip — keep the installed version");
  });

  it("renders a blocked row for a manifest entry from a disallowed source", async () => {
    const previous: AuraManifestSkill = {
      id: "review",
      pinned: false,
      source: "directory:acme",
      treeHash: HASH_1,
      version: "1.0.0",
    };
    const catalog = fakeCatalog({
      policy: { allowedSourceIds: new Set(["plugin:official"]), presetName: ".aura/preset.json" },
    });
    const scripted = io([]);

    await skillsStep.gather(context(catalog, [previous]), scripted);

    const row = scripted.asked[0]?.[0]?.options[0];
    expect(row?.label).toBe("review (blocked)");
    expect(row?.disabled).toBe(true);
    expect(row?.description).toContain('team preset ".aura/preset.json"');
  });

  it("notes and disables a source that is unavailable without its token", async () => {
    const catalog = fakeCatalog({
      notes: [],
      unavailableSources: [
        { hint: "set ACME_SKILLS_TOKEN", id: "directory:acme", name: "Acme Skills" },
      ],
    });
    const scripted = io([]);

    await skillsStep.gather(context(catalog), scripted);

    const row = scripted.asked[0]?.[0]?.options[0];
    expect(row?.disabled).toBe(true);
    expect(row?.label).toBe("Acme Skills");
    expect(row?.description).toBe("unavailable (set ACME_SKILLS_TOKEN)");
  });

  it("propagates back and abort outcomes", async () => {
    const catalog = fakeCatalog({ entries: [REMOTE_ENTRY] });

    await expect(
      skillsStep.gather(context(catalog), createScriptedWizardIo({ forms: ["back"] })),
    ).resolves.toBe(SETUP_BACK);
    await expect(
      skillsStep.gather(context(catalog), createScriptedWizardIo({ forms: ["aborted"] })),
    ).resolves.toBe(SETUP_ABORTED);
  });
});
