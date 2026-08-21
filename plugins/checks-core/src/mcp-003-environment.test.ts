import type { WorkspaceModel } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { mcp003 } from "./mcp-003.js";
import { model } from "./testing.js";

describe("MCP-003 credential environment", () => {
  it("reports unset required environment variables as informational guidance", () => {
    const workspace = workspaceWithVariable(false);
    const run = runChecks([mcp003], workspace);

    expect(run.diagnostics).toEqual([]);
    expect(run.findings).toEqual([
      expect.objectContaining({
        message: "MCP server docs needs environment variable DOCS_TOKEN.",
        metadata: expect.objectContaining({ kind: "environment", variableName: "DOCS_TOKEN" }),
        severity: "info",
      }),
    ]);
  });

  it("stays silent when a required environment variable is set", () => {
    expect(runChecks([mcp003], workspaceWithVariable(true)).findings).toEqual([]);
  });
});

function workspaceWithVariable(isSet: boolean): WorkspaceModel {
  return model({
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
            transport: { command: "docs-mcp", env: ["DOCS_TOKEN"], type: "stdio" },
          },
        ],
        ownership: {},
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
    },
    mcpEnvironmentVariables: [{ isSet, name: "DOCS_TOKEN" }],
  });
}
