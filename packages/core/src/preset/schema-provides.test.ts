import { describe, expect, it } from "vitest";

import { validateTeamPreset } from "./schema.js";

function providedServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credentialEnv: [{ description: "API token.", name: "DOCS_TOKEN" }],
    description: "Serves the repository docs.",
    docsUrl: "https://docs.example.com",
    id: "repo/docs",
    name: "Docs",
    schemaVersion: 1,
    serverName: "repo-docs",
    transportTemplate: {
      args: ["-y", "docs-mcp"],
      command: "npx",
      env: ["DOCS_TOKEN"],
      type: "stdio",
    },
    ...overrides,
  };
}

describe("validateTeamPreset provides", () => {
  it("rejects provides wholesale unless the repository reader opted in", () => {
    const result = validateTeamPreset({
      provides: { mcpServers: [providedServer()] },
      schemaVersion: 1,
    });

    expect(result).toEqual({
      kind: "invalid",
      problem: "$.provides: only the repository preset may provide content",
    });
  });

  it("collects and freezes provided MCP definitions for the repository layer", () => {
    const result = validateTeamPreset(
      { provides: { mcpServers: [providedServer()] }, schemaVersion: 1 },
      { allowProvides: true },
    );

    expect(result.kind).toBe("preset");
    if (result.kind !== "preset") {
      throw new Error("expected a preset");
    }
    expect(result.preset.provides?.mcpServers).toHaveLength(1);
    expect(result.preset.provides?.mcpServers?.[0]?.id).toBe("repo/docs");
    expect(Object.isFrozen(result.preset.provides)).toBe(true);
    expect(Object.isFrozen(result.preset.provides?.mcpServers)).toBe(true);
  });

  it("accepts an empty provides envelope", () => {
    const result = validateTeamPreset({ provides: {}, schemaVersion: 1 }, { allowProvides: true });

    expect(result.kind).toBe("preset");
  });

  it.each([
    [{ mcpServers: "npx docs-mcp" }, "$.provides.mcpServers: must be an array"],
    [
      { mcpServers: [providedServer({ id: "official/docs" })] },
      '$.provides.mcpServers[0].id: must be namespaced "repo/<name>"',
    ],
    [
      { mcpServers: [providedServer(), providedServer({ serverName: "repo-docs-two" })] },
      "$.provides.mcpServers[1].id: must not duplicate another provided server id",
    ],
    [
      { mcpServers: [providedServer(), providedServer({ id: "repo/docs-two" })] },
      "$.provides.mcpServers[1].serverName: must not duplicate another provided server name",
    ],
    [
      { mcpServers: [providedServer({ transportTemplate: undefined })] },
      "$.provides.mcpServers[0].transportTemplate",
    ],
    [
      { mcpServers: [providedServer({ serverName: "Not A Server Name!" })] },
      "$.provides.mcpServers[0].serverName",
    ],
    [
      {
        mcpServers: [
          providedServer({
            transportTemplate: { command: "npx", env: ["UNDECLARED"], type: "stdio" },
          }),
        ],
      },
      "$.provides.mcpServers[0].transportTemplate.env[0]",
    ],
  ])("rejects a malformed provides envelope", (provides, fragment) => {
    const result = validateTeamPreset({ provides, schemaVersion: 1 }, { allowProvides: true });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") {
      throw new Error("expected a problem");
    }
    expect(result.problem).toContain(fragment);
  });

  it("caps the number of provided servers", () => {
    const servers = Array.from({ length: 17 }, (_, index) =>
      providedServer({ id: `repo/server-${String(index)}`, serverName: `repo-${String(index)}` }),
    );

    const result = validateTeamPreset(
      { provides: { mcpServers: servers }, schemaVersion: 1 },
      { allowProvides: true },
    );

    expect(result).toEqual({
      kind: "invalid",
      problem: "$.provides.mcpServers: must contain at most 16 definitions",
    });
  });

  it("accepts a repo: skill selection and repo/ ids in the selection lists", () => {
    const result = validateTeamPreset(
      {
        requiredMcpServers: ["repo/docs"],
        schemaVersion: 1,
        skills: [{ id: "release-runbook", source: "repo:workspace" }],
        snippets: ["repo/commit-style"],
      },
      { allowProvides: true },
    );

    expect(result.kind).toBe("preset");
    if (result.kind !== "preset") {
      throw new Error("expected a preset");
    }
    expect(result.preset.skills?.[0]?.source).toBe("repo:workspace");
    expect(result.preset.snippets).toEqual(["repo/commit-style"]);
    expect(result.preset.requiredMcpServers).toEqual(["repo/docs"]);
  });
});
