import { runChecks } from "@tryaura/core";
import type { McpSecretSighting } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { mcp004 } from "./mcp-004.js";
import { app, model } from "./testing.js";

describe("MCP-004", () => {
  it("keeps unsupported Codex argv credentials as error-level manual findings", () => {
    const sighting: McpSecretSighting = {
      appId: "codex",
      field: "args[2]",
      locator: { index: 2, kind: "arg" },
      recordPath: ["mcp_servers"],
      scope: "global",
      serverName: "docs",
      sourceId: "codex.mcp.global",
      suggestedEnvName: "DOCS_ARGS_2",
    };
    const workspace = {
      ...model({
        apps: [
          app({
            adapterId: "codex",
            sources: [
              {
                exists: true,
                pathKind: "file",
                spec: {
                  id: "codex.mcp.global",
                  kind: "mcp",
                  path: "/home/dev/.codex/config.toml",
                  scope: "global",
                },
              },
            ],
          }),
        ],
      }),
      mcpSecretSightings: [sighting],
    };

    const finding = runChecks([mcp004], workspace).findings[0];
    expect(finding).toMatchObject({
      checkId: "MCP-004",
      fixability: "manual",
      locations: [{ path: "/home/dev/.codex/config.toml" }],
      metadata: {
        appId: "codex",
        field: "args[2]",
        serverName: "docs",
        sourceId: "codex.mcp.global",
        suggestedEnvName: "DOCS_ARGS_2",
      },
      severity: "error",
    });
    expect(JSON.stringify(finding)).not.toContain("credential-value");
  });
});
