import type { AuraTeamPreset, DirectorySkillSource } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { collectSkillDirectorySources, isSkillSourceAllowed } from "./sources.js";

const OFFICIAL: DirectorySkillSource = {
  id: "directory:agenticskills",
  kind: "directory",
  name: "agenticskills.io",
  url: "https://agenticskills.io",
};

const ACME: DirectorySkillSource = {
  id: "directory:acme",
  kind: "private-directory",
  name: "Acme Skills",
  tokenEnv: "ACME_SKILLS_TOKEN",
  url: "https://skills.acme.example",
};

describe("collectSkillDirectorySources", () => {
  it("merges preset directories after registered ones", () => {
    const result = collectSkillDirectorySources([OFFICIAL], {
      schemaVersion: 1,
      skillDirectories: [ACME],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.sources).toEqual([OFFICIAL, ACME]);
  });

  it("keeps the registered directory when a preset repeats its id", () => {
    const impostor: DirectorySkillSource = { ...OFFICIAL, url: "https://impostor.example" };

    const result = collectSkillDirectorySources([OFFICIAL], {
      schemaVersion: 1,
      skillDirectories: [impostor],
    });

    expect(result.sources).toEqual([OFFICIAL]);
    expect(result.diagnostics[0]?.message).toContain("duplicates a registered directory");
  });

  it("drops sources the allowlist refuses before anything can list them", () => {
    const preset: AuraTeamPreset = {
      allowedSkillSources: ["directory:acme"],
      schemaVersion: 1,
      skillDirectories: [ACME],
    };

    const result = collectSkillDirectorySources([OFFICIAL], preset);

    expect(result.sources).toEqual([ACME]);
  });

  it("permits everything when no preset or allowlist exists", () => {
    expect(collectSkillDirectorySources([OFFICIAL], undefined).sources).toEqual([OFFICIAL]);
    expect(collectSkillDirectorySources([OFFICIAL], { schemaVersion: 1 }).sources).toEqual([
      OFFICIAL,
    ]);
  });
});

describe("isSkillSourceAllowed", () => {
  it("treats the allowlist as exhaustive when present", () => {
    const preset: AuraTeamPreset = {
      allowedSkillSources: ["plugin:official"],
      schemaVersion: 1,
    };

    expect(isSkillSourceAllowed(preset, "plugin:official")).toBe(true);
    expect(isSkillSourceAllowed(preset, "directory:agenticskills")).toBe(false);
    expect(isSkillSourceAllowed(undefined, "directory:agenticskills")).toBe(true);
    expect(isSkillSourceAllowed({ schemaVersion: 1 }, "directory:agenticskills")).toBe(true);
  });
});
