import type { AuraManifestSkill } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import {
  fakeCatalog,
  HASH_1,
  HASH_2,
  recordingIo as io,
  REMOTE_ENTRY,
  REPO_IDENTITY,
  repoEntry,
  repoPack,
  skillStepContext as context,
} from "./skills.test-support.js";
import { skillsStep } from "./skills.js";

describe("skillsStep with repository skills", () => {
  it("leads the installable rows with the repository entries", async () => {
    const pack = repoPack(HASH_1);
    const catalog = fakeCatalog({ entries: [repoEntry(pack), REMOTE_ENTRY] });
    const scripted = io([]);

    await skillsStep.gather(context(catalog, [], { repo: { skills: [pack] } }), scripted);

    const options = scripted.asked[0]?.[0]?.options ?? [];
    expect(options.map((option) => option.value)).toEqual([REPO_IDENTITY, REMOTE_ENTRY.identity]);
    expect(options[0]?.group).toBe("This repository");
    expect(options[0]?.preview).toBe("# Release runbook\n");
  });

  it("pre-selects a repo-selected skill but holds it at Review under a scripted run", async () => {
    const pack = repoPack(HASH_1);
    const catalog = fakeCatalog({ entries: [repoEntry(pack)] });
    const scripted = io([]);
    const selected = [{ id: "release-runbook", source: "repo:workspace" as const }];

    const outcome = await skillsStep.gather(
      context(catalog, [], {
        manifestMissing: true,
        repo: { selected, skills: [pack] },
      }),
      scripted,
    );

    expect(scripted.asked[0]?.[0]?.initial).toEqual([REPO_IDENTITY]);
    expect(scripted.asked[0]?.[0]?.options[0]?.label).toBe("Release runbook (from repo)");
    // Review defaulted to Skip, so nothing repo-authored was first-installed.
    expect(outcome).not.toMatchObject({
      skills: { selected: [{ id: "release-runbook", source: "repo:workspace" }] },
    });
  });

  it("installs a repo skill only through an explicit Review install", async () => {
    const pack = repoPack(HASH_1);
    const catalog = fakeCatalog({ entries: [repoEntry(pack)] });
    const scripted = io([
      { skills: { kind: "options", values: [REPO_IDENTITY] } },
      { [`review:${REPO_IDENTITY}`]: { kind: "options", values: ["install"] } },
    ]);

    const outcome = await skillsStep.gather(
      context(catalog, [], { repo: { skills: [pack] } }),
      scripted,
    );

    expect(outcome).toMatchObject({
      skills: {
        resolved: [{ id: "release-runbook", treeHash: HASH_1 }],
        selected: [{ id: "release-runbook", source: "repo:workspace" }],
      },
    });
  });

  it("converges a recorded, unmoved repo skill without re-review", async () => {
    const previous: AuraManifestSkill = {
      id: "release-runbook",
      pinned: false,
      source: "repo:workspace",
      treeHash: HASH_1,
      version: "1.0.0",
    };
    const pack = repoPack(HASH_1);
    const catalog = fakeCatalog({ entries: [repoEntry(pack)] });
    const scripted = io([]);

    const outcome = await skillsStep.gather(
      context(catalog, [previous], { repo: { skills: [pack] } }),
      scripted,
    );

    // One question only — the picker; no Review stage for an unmoved recorded tree.
    expect(scripted.asked).toHaveLength(1);
    expect(outcome).toMatchObject({
      skills: {
        resolved: [{ id: "release-runbook", treeHash: HASH_1 }],
        selected: [{ id: "release-runbook", source: "repo:workspace" }],
      },
    });
  });

  it("re-reviews a moved repo tree and keeps the recorded version on Skip", async () => {
    const previous: AuraManifestSkill = {
      id: "release-runbook",
      pinned: false,
      source: "repo:workspace",
      treeHash: HASH_1,
      version: "1.0.0",
    };
    const pack = repoPack(HASH_2, "2.0.0");
    const catalog = fakeCatalog({ entries: [repoEntry(pack)] });
    const scripted = io([]);

    const outcome = await skillsStep.gather(
      context(catalog, [previous], { repo: { skills: [pack] } }),
      scripted,
    );

    // The Review question exists (two forms asked) and Skip leaves the moved tree uninstalled.
    expect(scripted.asked.length).toBeGreaterThan(1);
    expect(outcome).toMatchObject({
      skills: { selected: [{ id: "release-runbook", source: "repo:workspace" }] },
    });
    const skills = (outcome as { skills?: { resolved?: readonly unknown[] } }).skills;
    expect(skills?.resolved ?? []).toEqual([]);
  });
});
