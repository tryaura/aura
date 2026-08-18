/* eslint-disable max-lines -- the preset-v1 parser matrix keeps all recognized fields and safety limits together. */
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

    expect(state).toEqual({ diagnostics: [], preset: undefined, status: "missing" });
  });

  it("parses the allowlist and directory definitions", async () => {
    const reader = createMemoryReader({
      [PATH]: preset({
        allowedSkillSources: ["directory:acme", "plugin:official"],
        requiredMcpServers: ["official/github", "official/sentry"],
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
      requiredMcpServers: ["official/github", "official/sentry"],
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

  it("parses and freezes the complete runtime v1 contract while tolerating extensions", async () => {
    const state = await readTeamPreset(
      "/workspace",
      createMemoryReader({
        [PATH]: preset({
          checks: {
            disabled: ["MCP-002"],
            enabled: ["INS-007"],
            severity: { "INS-007": "error" },
            thresholds: { "INS-007": { approxTokens: 12_000 } },
          },
          future: { mode: "strict" },
          name: "Acme platform",
          requiredMcpServers: ["official/github"],
          schemaVersion: 1,
          skills: [{ id: "review", source: "plugin:official" }],
          snippets: ["official/engineering"],
        }),
      }),
    );

    expect(state.preset).toMatchObject({
      checks: {
        disabled: ["MCP-002"],
        enabled: ["INS-007"],
        severity: { "INS-007": "error" },
        thresholds: { "INS-007": { approxTokens: 12_000 } },
      },
      name: "Acme platform",
      requiredMcpServers: ["official/github"],
      skills: [{ id: "review", source: "plugin:official" }],
      snippets: ["official/engineering"],
    });
    expect(Object.isFrozen(state.preset)).toBe(true);
    expect(Object.isFrozen(state.preset?.checks?.thresholds?.["INS-007"])).toBe(true);
    expect(state.preset).not.toHaveProperty("future");
  });

  it.each([
    [
      { checks: { disabled: ["INS-007"], enabled: ["INS-007"] }, schemaVersion: 1 },
      "must not both enable and disable",
    ],
    [
      { requiredMcpServers: ["official/github", "official/github"], schemaVersion: 1 },
      "must not duplicate",
    ],
    [
      {
        schemaVersion: 1,
        skills: [
          { id: "review", source: "plugin:official" },
          { id: "review", source: "plugin:official" },
        ],
      },
      "must not duplicate",
    ],
    [
      { checks: { severity: { "INS-007": "critical" } }, schemaVersion: 1 },
      "must be error, info, or warn",
    ],
    [{ checks: { thresholds: { "INS-007": 12_000 } }, schemaVersion: 1 }, "must be an object"],
  ])("rejects conflicting or malformed runtime fields", async (document, message) => {
    const state = await readTeamPreset(
      "/workspace",
      createMemoryReader({ [PATH]: preset(document) }),
    );

    expect(state.status).toBe("invalid");
    expect(state.diagnostics[0]?.message).toContain(message);
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

  it("keeps script-looking and path-shaped threshold strings as inert data", async () => {
    const state = await readTeamPreset(
      "/workspace",
      createMemoryReader({
        [PATH]:
          '{"schemaVersion":1,"checks":{"thresholds":{"INS-007":{"path":"$HOME","script":"postinstall"}}},"vendor":{"__proto__":{"polluted":true}}}',
      }),
    );

    expect(state.preset?.checks?.thresholds?.["INS-007"]).toEqual({
      path: "$HOME",
      script: "postinstall",
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("accepts a name that resembles a JSON path and bounds unknown-field depth", async () => {
    const named = await readTeamPreset(
      "/workspace",
      createMemoryReader({ [PATH]: preset({ name: "$.name: platform", schemaVersion: 1 }) }),
    );
    let nested: unknown = true;
    for (let index = 0; index < 101; index += 1) {
      nested = { nested };
    }
    const deep = await readTeamPreset(
      "/workspace",
      createMemoryReader({ [PATH]: preset({ schemaVersion: 1, vendor: nested }) }),
    );

    expect(named.preset?.name).toBe("$.name: platform");
    expect(deep.diagnostics[0]?.message).toContain("nested deeper than the 100 level limit");
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
    [{ requiredMcpServers: ["github"], schemaVersion: 1 }, "$.requiredMcpServers[0]"],
    [
      { requiredMcpServers: ["official/github", "official/github"], schemaVersion: 1 },
      "must not duplicate",
    ],
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
    [
      {
        schemaVersion: 1,
        skillDirectories: [
          { id: "directory:acme", name: "Acme", url: "https://skills.acme.example?team=one" },
        ],
      },
      "query string or fragment, which is not allowed",
    ],
    [
      {
        schemaVersion: 1,
        skillDirectories: [
          { id: "directory:acme", name: "Acme", url: "https://user@skills.acme.example" },
        ],
      },
      "embedded username or password credentials, which are not allowed",
    ],
  ])("rejects invalid preset %j", async (document, fragment) => {
    const state = await readTeamPreset(
      "/workspace",
      createMemoryReader({ [PATH]: preset(document) }),
    );

    expect(state.preset).toBeUndefined();
    expect(state.diagnostics[0]?.message).toContain("is not a valid team preset");
    expect(state.diagnostics[0]?.message).toContain(fragment);
    expect(state.status).toBe("invalid");
  });

  it("caps source allowlists and directory definitions", async () => {
    const allowed = await readTeamPreset(
      "/workspace",
      createMemoryReader({
        [PATH]: preset({
          allowedSkillSources: Array.from(
            { length: 257 },
            (_, index) => `plugin:p${String(index)}`,
          ),
          schemaVersion: 1,
        }),
      }),
    );
    const directories = await readTeamPreset(
      "/workspace",
      createMemoryReader({
        [PATH]: preset({
          schemaVersion: 1,
          skillDirectories: Array.from({ length: 33 }, (_, index) => ({
            id: `directory:d${String(index)}`,
            name: `Directory ${String(index)}`,
            url: `https://d${String(index)}.example`,
          })),
        }),
      }),
    );
    const mcpServers = await readTeamPreset(
      "/workspace",
      createMemoryReader({
        [PATH]: preset({
          requiredMcpServers: Array.from(
            { length: 257 },
            (_, index) => `official/server-${String(index)}`,
          ),
          schemaVersion: 1,
        }),
      }),
    );

    expect(allowed.diagnostics[0]?.message).toContain("at most 256");
    expect(directories.diagnostics[0]?.message).toContain("at most 32");
    expect(mcpServers.diagnostics[0]?.message).toContain("at most 256");
  });

  it("does not echo rejected URL credentials or query values", async () => {
    const state = await readTeamPreset(
      "/workspace",
      createMemoryReader({
        [PATH]: preset({
          schemaVersion: 1,
          skillDirectories: [
            {
              id: "directory:acme",
              name: "Acme",
              url: "https://secret-user@skills.acme.example?token=secret-query",
            },
          ],
        }),
      }),
    );

    expect(JSON.stringify(state.diagnostics)).not.toContain("secret-user");
    expect(JSON.stringify(state.diagnostics)).not.toContain("secret-query");
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
