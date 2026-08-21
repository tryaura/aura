import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { definePlugin, type ResolvedMcpServerDef, type WorkspaceModel } from "@tryaura/aura-sdk";
import { createPluginRegistry } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createMcpSetupCatalog, mcpCatalogEntryName } from "./mcp-catalog.js";

describe("MCP setup catalog", () => {
  it("merges preset, configured, custom, and plugin provenance in picker order", () => {
    const github = definition("official/github", "GitHub", "github");
    const alpha = definition("official/alpha", "Alpha", "alpha");
    const registry = createPluginRegistry([
      definePlugin({
        apiVersion: 1,
        id: "official",
        mcpCatalog: [github, alpha],
        name: "Official MCP",
        version: "1.0.0",
      }),
    ]);
    const manifest: WorkspaceModel["manifest"] = {
      exists: true,
      path: "/home/dev/agents/aura.json",
      status: "ready",
      value: {
        apps: {},
        mcpServers: [
          {
            apps: ["codex"],
            name: "local-docs",
            scope: "global",
            transport: { command: "docs", type: "stdio" },
          },
        ],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
    };
    const model = createWorkspaceModel({
      availableMcpServers: [github, alpha],
      manifest,
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });

    const catalog = createMcpSetupCatalog({
      model,
      preset: { requiredMcpServers: ["official/github"], schemaVersion: 1 },
      registry,
    });

    expect(catalog.entries.map(mcpCatalogEntryName)).toEqual(["GitHub", "local-docs", "Alpha"]);
    expect(catalog.entries[0]).toMatchObject({ required: true, sourceName: "Official MCP" });
    expect(catalog.entries[1]).toMatchObject({ existing: { name: "local-docs" } });
  });

  it("sorts required first, then repository definitions, then configured, then by name", () => {
    const alpha = definition("official/alpha", "Alpha", "alpha");
    const github = definition("official/github", "GitHub", "github");
    const repoDocs = definition("repo/docs", "Repo Docs", "repo-docs");
    const manifest: WorkspaceModel["manifest"] = {
      exists: true,
      path: "/home/dev/agents/aura.json",
      status: "ready",
      value: {
        apps: {},
        mcpServers: [
          {
            apps: ["codex"],
            name: "local-docs",
            scope: "global",
            transport: { command: "docs", type: "stdio" },
          },
        ],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
    };
    const model = createWorkspaceModel({
      availableMcpServers: [alpha, github, repoDocs],
      manifest,
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });

    const catalog = createMcpSetupCatalog({
      model,
      preset: { requiredMcpServers: ["official/github"], schemaVersion: 1 },
      registry: createPluginRegistry([]),
    });

    expect(catalog.entries.map(mcpCatalogEntryName)).toEqual([
      "GitHub",
      "Repo Docs",
      "local-docs",
      "Alpha",
    ]);
    expect(catalog.entries[1]).toMatchObject({ repo: true, sourceName: undefined });
  });

  it("keeps a repo-required definition at the very top with both flags", () => {
    const repoDocs = definition("repo/docs", "Repo Docs", "repo-docs");
    const alpha = definition("official/alpha", "Alpha", "alpha");
    const model = createWorkspaceModel({
      availableMcpServers: [alpha, repoDocs],
      manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });

    const catalog = createMcpSetupCatalog({
      model,
      preset: { requiredMcpServers: ["repo/docs"], schemaVersion: 1 },
      registry: createPluginRegistry([]),
    });

    expect(catalog.entries.map(mcpCatalogEntryName)).toEqual(["Repo Docs", "Alpha"]);
    expect(catalog.entries[0]).toMatchObject({ repo: true, required: true });
  });

  it("reports required catalog ids that did not resolve", () => {
    const model = createWorkspaceModel({
      manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });
    const catalog = createMcpSetupCatalog({
      model,
      preset: { requiredMcpServers: ["official/missing"], schemaVersion: 1 },
      registry: createPluginRegistry([]),
    });

    expect(catalog.missingRequiredIds).toEqual(["official/missing"]);
  });
});

function definition(id: string, name: string, serverName: string): ResolvedMcpServerDef {
  const description = `${name} MCP server.`;
  return {
    description,
    id,
    kind: "mcp-server",
    manifest: {
      credentialEnv: [],
      description,
      docsUrl: "https://example.test/docs",
      id,
      name,
      schemaVersion: 1,
      serverName,
      transportTemplate: { type: "http", url: "https://example.test/mcp" },
    },
    name,
    source: { type: "file", url: `file:///catalog/${serverName}.json` },
    version: "1.0.0",
  };
}
