import { describe, expect, it } from "vitest";

import { parseAuraManifest, serializeAuraManifest } from "../index.js";

const PATH = "/home/dev/agents/aura.json";

describe("Aura manifest MCP definitions", () => {
  it("round-trips and freezes stdio definitions", () => {
    const source = manifestWithMcp({
      apps: ["codex", "cursor"],
      name: "github",
      transport: {
        args: ["-y", "@modelcontextprotocol/server-github"],
        command: "npx",
        env: ["GITHUB_TOKEN"],
        type: "stdio",
      },
    });

    const state = parseAuraManifest(JSON.stringify(source), PATH);
    if (state.status !== "ready") {
      throw new Error("expected a ready manifest");
    }

    expect(JSON.parse(serializeAuraManifest(state.value))).toEqual(source);
    expect(Object.isFrozen(state.value.mcpServers)).toBe(true);
    expect(Object.isFrozen(state.value.mcpServers[0])).toBe(true);
    expect(Object.isFrozen(state.value.mcpServers[0]?.transport)).toBe(true);
  });

  it.each([
    [
      manifestWithMcp({
        apps: ["codex"],
        name: "bad/name",
        transport: validStdio(),
      }),
      "$.mcpServers[0].name",
      "must match",
    ],
    [
      manifestWithMcp({
        apps: ["codex"],
        name: "constructor",
        transport: validStdio(),
      }),
      "$.mcpServers[0].name",
      "reserved",
    ],
    [
      manifestWithMcp({
        apps: ["codex", "codex"],
        name: "github",
        transport: validStdio(),
      }),
      "$.mcpServers[0].apps[1]",
      "duplicates",
    ],
    [
      manifestWithMcp({
        apps: ["codex"],
        name: "github",
        transport: { command: "npx", env: ["TOKEN=value"], type: "stdio" },
      }),
      "$.mcpServers[0].transport.env[0]",
      "NAME=value",
    ],
    [
      manifestWithMcp({
        apps: ["cursor"],
        name: "github",
        transport: {
          headers: { Authorization: "Bearer ghp_deadbeef ${GITHUB_TOKEN}" },
          type: "http",
          url: "https://example.test/mcp",
        },
      }),
      "$.mcpServers[0].transport.headers.Authorization",
      "credential literal",
    ],
    [
      manifestWithMcp({
        apps: ["codex"],
        name: "github",
        transport: {
          command: "npx",
          headers: { Authorization: "Bearer ghp_deadbeef" },
          type: "stdio",
        },
      }),
      "$.mcpServers[0].transport.headers",
      "must not appear on a stdio transport",
    ],
    [
      manifestWithMcp({ apps: [], name: "github", transport: validStdio() }),
      "$.mcpServers[0].apps",
      "at least one application",
    ],
  ])("makes an unsafe MCP value read-only at its exact path", (value, jsonPath, reason) => {
    const state = parseAuraManifest(JSON.stringify(value), PATH);

    expect(state.status).toBe("read-only");
    if (state.status !== "read-only") {
      throw new Error("expected a read-only manifest");
    }
    expect(state.problem).toMatchObject({ jsonPath, kind: "invalid-schema" });
    expect(state.problem.message).toContain(reason);
  });

  it("refuses two entries claiming one server name for the same application", () => {
    const source = {
      apps: {},
      mcpServers: [
        { apps: ["codex", "cursor"], name: "github", transport: validStdio() },
        { apps: ["cursor"], name: "github", transport: validStdio() },
      ],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    };

    const state = parseAuraManifest(JSON.stringify(source), PATH);

    expect(state).toMatchObject({
      problem: { jsonPath: "$.mcpServers[1].apps[0]" },
      status: "read-only",
    });
  });

  it.each(["global", "project"])(
    "migrates a legacy %s-scope entry instead of refusing the manifest",
    (scope) => {
      const source = manifestWithMcp({
        apps: ["codex"],
        name: "github",
        scope,
        transport: validStdio(),
      });

      const state = parseAuraManifest(JSON.stringify(source), PATH);
      if (state.status !== "ready") {
        throw new Error("expected a ready manifest");
      }

      expect(state.value.mcpServers[0]).not.toHaveProperty("scope");
      // The next converging write is the migration: serializing drops the property for good.
      expect(JSON.stringify(serializeAuraManifest(state.value))).not.toContain("scope");
    },
  );

  it("still refuses two legacy entries that differ only by scope", () => {
    const source = {
      apps: {},
      mcpServers: [
        { apps: ["codex"], name: "github", scope: "global", transport: validStdio() },
        { apps: ["codex"], name: "github", scope: "project", transport: validStdio() },
      ],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    };

    const state = parseAuraManifest(JSON.stringify(source), PATH);

    expect(state).toMatchObject({
      problem: {
        jsonPath: "$.mcpServers[1].apps[0]",
        message: expect.stringContaining("no longer separates MCP servers by scope"),
      },
      status: "read-only",
    });
  });
});

function validStdio(): object {
  return { command: "npx", env: ["GITHUB_TOKEN"], type: "stdio" };
}

function manifestWithMcp(server: object): object {
  return {
    apps: {},
    mcpServers: [server],
    ownership: {},
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}
