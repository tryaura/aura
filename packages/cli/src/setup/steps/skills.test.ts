import type { AuraManifestSkill } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { SETUP_ABORTED, SETUP_BACK } from "../types.js";
import { createScriptedWizardIo } from "../wizard-scripted.js";
import {
  fakeCatalog,
  BUNDLED_IDENTITY,
  bundledPack,
  HASH_1,
  HASH_2,
  PRIVATE_SOURCE,
  recordingIo as io,
  REMOTE_ENTRY,
  REMOTE_IDENTITY,
  remotePack,
  skillStepContext as context,
} from "./skills.test-support.js";
import { skillsStep } from "./skills.js";

describe("skillsStep", () => {
  it("returns unchanged selections when nothing is offered or recorded", async () => {
    const scripted = io([]);

    const outcome = await skillsStep.gather(context(fakeCatalog()), scripted);

    expect(outcome).toEqual({});
    expect(scripted.notes).toContain(
      "No skills are available from the installed plugins or directories.",
    );
  });

  it("labels and preselects a fresh preset skill", async () => {
    const pack = bundledPack(HASH_1);
    const catalog = fakeCatalog({
      entries: [
        {
          description: pack.description,
          id: pack.id,
          identity: BUNDLED_IDENTITY,
          name: pack.name,
          remote: false,
          sourceId: pack.source.id,
          sourceName: pack.source.name,
          version: pack.version,
        },
      ],
    });
    const scripted = io([]);

    const outcome = await skillsStep.gather(
      context(catalog, [], {
        availableSkills: [pack],
        manifestMissing: true,
        presetSkills: [{ id: "review", source: "plugin:official" }],
      }),
      scripted,
    );

    expect(scripted.asked[0]?.[0]?.initial).toEqual([BUNDLED_IDENTITY]);
    expect(scripted.asked[0]?.[0]?.options[0]?.label).toBe("Review (from preset)");
    expect(outcome).toMatchObject({
      skills: { selected: [{ id: "review", source: "plugin:official" }] },
    });
  });

  it("records an accepted bundled update but keeps it by default", async () => {
    const previous: AuraManifestSkill = {
      id: "review",
      pinned: false,
      source: "plugin:official",
      treeHash: HASH_1,
      version: "1.0.0",
    };
    const pack = bundledPack(HASH_2, "2.0.0");
    const catalog = fakeCatalog({
      entries: [
        {
          description: pack.description,
          id: pack.id,
          identity: BUNDLED_IDENTITY,
          name: pack.name,
          remote: false,
          sourceId: pack.source.id,
          sourceName: pack.source.name,
          version: pack.version,
        },
      ],
    });
    const stepContext = context(catalog, [previous], { availableSkills: [pack] });

    const kept = await skillsStep.gather(stepContext, io([]));
    const updated = await skillsStep.gather(
      stepContext,
      io([{}, { [`review:${BUNDLED_IDENTITY}`]: { kind: "options", values: ["install"] } }]),
    );

    expect(kept).toMatchObject({ skills: { selected: [{ id: "review" }] } });
    if (typeof kept === "symbol") {
      throw new Error("expected selections");
    }
    expect(kept.skills?.updates).toBeUndefined();
    expect(updated).toMatchObject({ skills: { updates: [BUNDLED_IDENTITY] } });
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

  it("requires an explicit connection choice before using a private directory", async () => {
    const catalog = fakeCatalog({
      entries: [REMOTE_ENTRY],
      packs: new Map([[REMOTE_IDENTITY, remotePack(HASH_1)]]),
      privateSources: [PRIVATE_SOURCE],
    });
    const scripted = io([
      {
        "approved-private-sources": {
          kind: "options",
          values: ["directory:acme"],
        },
      },
      { skills: { kind: "options", values: [REMOTE_IDENTITY] } },
      { [`review:${REMOTE_IDENTITY}`]: { kind: "options", values: ["install"] } },
    ]);

    const outcome = await skillsStep.gather(context(catalog), scripted);

    expect(scripted.asked[0]?.[0]?.prompt).toContain("may Aura connect");
    expect(scripted.asked[0]?.[0]?.initial).toEqual([]);
    expect(outcome).toMatchObject({
      skills: { approvedPrivateSourceIds: ["directory:acme"] },
    });
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
    expect(row?.description).toContain('repository preset ".aura/preset.json"');
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
