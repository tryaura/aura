import type { AuraManifestSkill } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { skillIdentity } from "../skill-planner-paths.js";
import {
  fakeCatalog,
  HASH_1,
  recordingIo as io,
  REMOTE_ENTRY,
  REMOTE_IDENTITY,
  remotePack,
  skillStepContext as context,
  supportedApp,
  unsupportedApp,
} from "./skills.test-support.js";
import { skillsStep } from "./skills.js";

const RECORDED: AuraManifestSkill = {
  id: "review",
  pinned: false,
  source: "directory:acme",
  treeHash: HASH_1,
  version: "1.0.0",
};

describe("skillsStep support matrix", () => {
  it("states support once in the prompt, not on every row", async () => {
    const bundledIdentity = skillIdentity("plugin:official", "audit");
    const catalog = fakeCatalog({
      entries: [
        REMOTE_ENTRY,
        {
          description: "Audit a repository.",
          id: "audit",
          identity: bundledIdentity,
          name: "Audit",
          preview: "# Audit skill\n",
          remote: false,
          sourceId: "plugin:official",
          sourceName: "Aura Official",
          version: "1.0.0",
        },
      ],
    });
    const scripted = io([]);

    await skillsStep.gather(context(catalog), scripted);

    const picker = scripted.asked[0]?.[0];
    expect(picker?.prompt).toContain("Apps: ✓ Codex");
    expect(picker?.options).toHaveLength(2);
    expect(picker?.options.every((row) => row.description?.includes("Apps:") !== true)).toBe(true);
    expect(picker?.options.every((row) => row.disabled !== true)).toBe(true);
    expect(picker?.options.find((row) => row.value === bundledIdentity)?.preview).toBe(
      "# Audit skill\n",
    );
  });

  it("shows mixed support in catalog order and marks unknown managed adapters", async () => {
    const scripted = io([]);

    await skillsStep.gather(
      context(fakeCatalog({ entries: [REMOTE_ENTRY] }), [], {
        appCatalog: [supportedApp("codex", "Codex"), unsupportedApp("cursor", "Cursor")],
        manifestAppIds: ["cursor", "legacy", "codex"],
      }),
      scripted,
    );

    expect(scripted.asked[0]?.[0]?.prompt).toContain(
      "Apps: ✓ Codex · — Cursor · ? legacy (not in this build)",
    );
  });

  it("uses the current Apps-step answer instead of the manifest support", async () => {
    const scripted = io([]);

    await skillsStep.gather(
      context(fakeCatalog({ entries: [REMOTE_ENTRY] }), [], {
        appCatalog: [supportedApp("codex", "Codex"), unsupportedApp("cursor", "Cursor")],
        manifestAppIds: ["codex"],
        selectedAppIds: ["cursor"],
      }),
      scripted,
    );

    const picker = scripted.asked[0]?.[0];
    expect(picker?.prompt).toContain("No selected application supports Agent Skills");
    expect(picker?.prompt).toContain("Apps: — Cursor");
    expect(picker?.options[0]?.disabled).toBe(true);
    expect(picker?.options[0]?.disabledNote).toBe("no selected app supports skills");
  });

  it("drops a stale new selection after Apps changes to an unsupported app", async () => {
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
    });
    const base = context(catalog, [], {
      appCatalog: [unsupportedApp("cursor", "Cursor")],
      manifestAppIds: [],
      selectedAppIds: ["cursor"],
    });
    const scripted = io([]);

    const outcome = await skillsStep.gather(
      {
        ...base,
        selections: {
          apps: { managed: ["cursor"] },
          skills: { selected: [{ id: "review", source: "directory:acme" }] },
        },
      },
      scripted,
    );

    expect(scripted.asked[0]?.[0]?.initial).toEqual([]);
    expect(outcome).toEqual({ apps: { managed: ["cursor"] } });
    expect(scripted.asked).toHaveLength(1);
  });

  it("names the selections it cleared instead of dropping them silently", async () => {
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
    });
    const base = context(catalog, [], {
      appCatalog: [unsupportedApp("cursor", "Cursor")],
      manifestAppIds: [],
      selectedAppIds: ["cursor"],
    });

    const scripted = io([]);
    await skillsStep.gather(
      {
        ...base,
        selections: {
          apps: { managed: ["cursor"] },
          skills: { selected: [{ id: "review", source: "directory:acme" }] },
        },
      },
      scripted,
    );

    expect(scripted.notes.some((note) => note.startsWith("Cleared review:"))).toBe(true);
  });

  it("keeps an unsupported installed skill checked and lets the user clear it", async () => {
    const scripted = io([{ skills: { kind: "options", values: [] } }]);

    const outcome = await skillsStep.gather(
      context(fakeCatalog({ entries: [REMOTE_ENTRY] }), [RECORDED], {
        appCatalog: [unsupportedApp("cursor", "Cursor")],
        manifestAppIds: ["cursor"],
      }),
      scripted,
    );

    const picker = scripted.asked[0]?.[0];
    expect(picker?.initial).toEqual([REMOTE_IDENTITY]);
    expect(picker?.options[0]?.disabled).toBe(true);
    expect(scripted.notes.some((note) => note.startsWith("Cleared"))).toBe(false);
    expect(outcome).toEqual({ skills: { resolved: [], selected: [] } });
  });
});

describe("skillsStep prerequisites", () => {
  const requirement = skillsStep.prerequisites?.[1];

  it("is unmet when every managed application lacks Agent Skills support", () => {
    const unmet = context(fakeCatalog({ entries: [REMOTE_ENTRY] }), [], {
      appCatalog: [unsupportedApp("cursor", "Cursor")],
      manifestAppIds: ["cursor"],
    });

    expect(requirement?.isSatisfied(unmet)).toBe(false);
    expect(requirement?.title).toBe("a managed application that supports Agent Skills");
  });

  it("is unmet when a managed application is not in this build", () => {
    const unmet = context(fakeCatalog({ entries: [REMOTE_ENTRY] }), [], {
      appCatalog: [supportedApp("codex", "Codex")],
      manifestAppIds: ["legacy"],
    });

    expect(requirement?.isSatisfied(unmet)).toBe(false);
  });

  it("stays met without support when the manifest still records a skill to remove", () => {
    const uninstall = context(fakeCatalog({ entries: [REMOTE_ENTRY] }), [RECORDED], {
      appCatalog: [unsupportedApp("cursor", "Cursor")],
      manifestAppIds: ["cursor"],
    });

    expect(requirement?.isSatisfied(uninstall)).toBe(true);
  });

  it("is met by a managed application that supports Agent Skills", () => {
    const met = context(fakeCatalog({ entries: [REMOTE_ENTRY] }));

    expect(requirement?.isSatisfied(met)).toBe(true);
  });
});
