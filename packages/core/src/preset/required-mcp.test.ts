import type { AppModel, AuraEffectiveConfig, WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { describe, expect, it } from "vitest";

import { applyRequiredMcpServers } from "./required-mcp.js";

const app: AppModel = {
  adapterId: "claude-code",
  detection: { installed: true, version: "1.0.0" },
  displayName: "Claude Code",
  instructionFiles: [],
  mcpServers: [],
  skills: [],
  sourceFiles: [],
  support: { status: "supported", supportedRange: ">=1", version: "1.0.0" },
};
const catalog: WorkspaceModel["availableMcpServers"][number] = {
  description: "Docs.",
  id: "official/docs",
  kind: "mcp-server",
  manifest: {
    credentialEnv: [],
    description: "Docs.",
    docsUrl: "https://docs.example.test",
    id: "official/docs",
    name: "Docs",
    schemaVersion: 1,
    supportedApps: ["claude-code"],
    transportTemplate: { command: "docs-mcp", type: "stdio" },
  },
  name: "Docs",
  source: { type: "file", url: "file:///plugins/docs.json" },
  version: "1.0.0",
};

describe("applyRequiredMcpServers", () => {
  it("projects a catalog requirement into managed supported applications", () => {
    const model = createWorkspaceModel({
      apps: [app],
      availableMcpServers: [catalog],
      manifest: {
        exists: true,
        path: "/home/dev/agents/aura.json",
        status: "ready",
        value: {
          apps: { "claude-code": { managed: true } },
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        },
      },
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });

    expect(applyRequiredMcpServers(model, config()).model.requiredMcpServers).toEqual([
      {
        apps: ["claude-code"],
        catalogId: "official/docs",
        name: "docs",
        requiredBy: "Acme platform",
        scope: "global",
        transport: { command: "docs-mcp", type: "stdio" },
      },
    ]);
  });

  it("does not target an application version the adapter marked unsupported", () => {
    const model = createWorkspaceModel({
      apps: [{ ...app, support: { status: "unsupported", supportedRange: ">=2", version: "1" } }],
      availableMcpServers: [catalog],
      manifest: {
        exists: true,
        path: "/home/dev/agents/aura.json",
        status: "ready",
        value: {
          apps: { "claude-code": { managed: true } },
          mcpServers: [],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        },
      },
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });

    const projected = applyRequiredMcpServers(model, config());

    expect(projected.model).toBe(model);
    expect(projected.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'MCP server "official/docs" required by Acme platform has no managed application that supports it, so it was skipped.',
    ]);
  });

  it("keeps a server the manifest already configures and says the requirement was not applied", () => {
    const model = createWorkspaceModel({
      apps: [app],
      availableMcpServers: [catalog],
      manifest: {
        exists: true,
        path: "/home/dev/agents/aura.json",
        status: "ready",
        value: {
          apps: { "claude-code": { managed: true } },
          mcpServers: [
            {
              apps: ["claude-code"],
              name: "docs",
              scope: "global",
              transport: { command: "my-own-docs", type: "stdio" },
            },
          ],
          ownership: {},
          schemaVersion: 1,
          skills: [],
          snippets: [],
        },
      },
      sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    });

    const projected = applyRequiredMcpServers(model, config());

    expect(projected.model).toBe(model);
    expect(projected.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'MCP server "official/docs" required by Acme platform is already configured as "docs", so your own settings were kept.',
    ]);
  });
});

function config(): AuraEffectiveConfig {
  return {
    checks: {},
    requiredMcpServers: [
      {
        provenance: { label: "Acme platform", layer: "preset" },
        value: "official/docs",
      },
    ],
    skillDirectories: [],
    skills: [],
    snippets: [],
  };
}
