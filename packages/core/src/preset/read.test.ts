import { describe, expect, it } from "vitest";

import { createMemoryReader } from "../workspace/testing.js";
import { readTeamPreset } from "./read.js";

const PATH = "/workspace/.aura/preset.json";

function preset(value: unknown): string {
  return JSON.stringify(value);
}

describe("readTeamPreset", () => {
  it("treats a missing file as no preset and no problem", async () => {
    const state = await readTeamPreset("/workspace", createMemoryReader());

    expect(state).toEqual({ diagnostics: [], preset: undefined });
  });

  it("parses the allowlist and directory definitions", async () => {
    const reader = createMemoryReader({
      [PATH]: preset({
        allowedSkillSources: ["directory:acme", "plugin:official"],
        schemaVersion: 1,
        skillDirectories: [
          {
            id: "directory:acme",
            name: "Acme Skills",
            tokenEnv: "ACME_SKILLS_TOKEN",
            url: "https://skills.acme.example",
          },
        ],
      }),
    });

    const state = await readTeamPreset("/workspace", reader);

    expect(state.diagnostics).toEqual([]);
    expect(state.preset).toEqual({
      allowedSkillSources: ["directory:acme", "plugin:official"],
      schemaVersion: 1,
      skillDirectories: [
        {
          id: "directory:acme",
          kind: "private-directory",
          name: "Acme Skills",
          tokenEnv: "ACME_SKILLS_TOKEN",
          url: "https://skills.acme.example",
        },
      ],
    });
  });

  it("reads a directory without tokenEnv as a public directory", async () => {
    const reader = createMemoryReader({
      [PATH]: preset({
        schemaVersion: 1,
        skillDirectories: [
          { id: "directory:oss", name: "OSS Skills", url: "https://skills.oss.example" },
        ],
      }),
    });

    const state = await readTeamPreset("/workspace", reader);

    expect(state.preset?.skillDirectories?.[0]?.kind).toBe("directory");
  });

  it("rejects broken JSON without echoing the bytes", async () => {
    const reader = createMemoryReader({ [PATH]: '{"schemaVersion": secret-token' });

    const state = await readTeamPreset("/workspace", reader);

    expect(state.preset).toBeUndefined();
    expect(state.diagnostics).toHaveLength(1);
    expect(state.diagnostics[0]?.message).toBe(
      'Team preset ".aura/preset.json" is not valid JSON, so it is ignored.',
    );
    expect(JSON.stringify(state.diagnostics)).not.toContain("secret-token");
  });

  it.each([
    [{ schemaVersion: 2 }, "$.schemaVersion: must be 1"],
    [{ allowedSkillSources: [":"], schemaVersion: 1 }, "$.allowedSkillSources[0]"],
    [{ schemaVersion: 1, skillDirectories: [{}] }, "$.skillDirectories[0].id"],
    [
      {
        schemaVersion: 1,
        skillDirectories: [
          { id: "directory:acme", name: "Acme", url: "http://skills.acme.example" },
        ],
      },
      "expected https (plain http is loopback-only)",
    ],
    [
      {
        schemaVersion: 1,
        skillDirectories: [
          {
            id: "directory:acme",
            name: "Acme",
            tokenEnv: "not upper",
            url: "https://skills.acme.example",
          },
        ],
      },
      "a name, never a value",
    ],
  ])("rejects invalid preset %j", async (document, fragment) => {
    const state = await readTeamPreset(
      "/workspace",
      createMemoryReader({ [PATH]: preset(document) }),
    );

    expect(state.preset).toBeUndefined();
    expect(state.diagnostics[0]?.message).toContain("is not a valid team preset");
    expect(state.diagnostics[0]?.message).toContain(fragment);
  });

  it("accepts loopback http for local test directories", async () => {
    const reader = createMemoryReader({
      [PATH]: preset({
        schemaVersion: 1,
        skillDirectories: [{ id: "directory:local", name: "Local", url: "http://127.0.0.1:8080" }],
      }),
    });

    const state = await readTeamPreset("/workspace", reader);

    expect(state.diagnostics).toEqual([]);
    expect(state.preset?.skillDirectories).toHaveLength(1);
  });
});
