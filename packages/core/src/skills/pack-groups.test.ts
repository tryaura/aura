import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Preset } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { loadSkillPackGroups } from "./pack-groups.js";

async function presetFile(name: string, document: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-pack-groups-"));
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(document), "utf8");
  return pathToFileURL(path).href;
}

function preset(id: string, url: string): Preset {
  return {
    description: "The everyday starter set.",
    id,
    kind: "preset",
    name: "Starter",
    source: { type: "file", url },
    version: "1.0.0",
  };
}

describe("loadSkillPackGroups", () => {
  it("offers a preset with a skill selection as one pack group", async () => {
    const url = await presetFile("starter.json", {
      schemaVersion: 1,
      skills: [
        { id: "review", source: "directory:acme" },
        { id: "triage", source: "directory:acme" },
      ],
    });

    const result = await loadSkillPackGroups([preset("official/starter", url)]);

    expect(result.notes).toEqual([]);
    expect(result.groups).toEqual([
      {
        description: "The everyday starter set.",
        id: "official/starter",
        name: "Starter",
        origin: "plugin",
        skills: [
          { id: "review", source: "directory:acme" },
          { id: "triage", source: "directory:acme" },
        ],
      },
    ]);
  });

  it("skips a policy-only preset silently and drops an invalid one with a note", async () => {
    const policyUrl = await presetFile("policy.json", {
      allowedSkillSources: ["directory:acme"],
      schemaVersion: 1,
    });
    const brokenUrl = await presetFile("broken.json", { schemaVersion: 2 });

    const result = await loadSkillPackGroups([
      preset("official/policy", policyUrl),
      preset("official/broken", brokenUrl),
    ]);

    expect(result.groups).toEqual([]);
    expect(result.notes).toEqual([
      'Skill pack "official/broken" is not a valid preset ($.schemaVersion: must be 1), so it is not offered.',
    ]);
  });

  it("drops an unreadable preset with a note instead of failing the listing", async () => {
    const result = await loadSkillPackGroups([
      preset("official/missing", "file:///nonexistent/aura-pack-groups/starter.json"),
    ]);

    expect(result.groups).toEqual([]);
    expect(result.notes).toEqual([
      'Skill pack "official/missing" could not be read, so it is not offered.',
    ]);
  });
});
