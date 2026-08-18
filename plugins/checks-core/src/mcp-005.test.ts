import { CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS } from "@tryaura/adapter-claude-code";
import { CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS } from "@tryaura/adapter-cursor";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { mcp001 } from "./mcp-001.js";
import { mcp005 } from "./mcp-005.js";
import { desired, opposite, PLACEMENTS, server, workspaceFor } from "./mcp-005-fixtures.js";

describe("MCP-005 detection", () => {
  it.each(PLACEMENTS)(
    "detects $appId placement toward $expectedScope scope",
    ({ appId, expectedScope, sourceId }) => {
      const actualScope = opposite(expectedScope);
      const workspace = workspaceFor({
        appId,
        expectedScope,
        ledger: ["docs"],
        servers: [server(appId, sourceId, actualScope)],
      });

      expect(runChecks([mcp005], workspace).findings[0]).toMatchObject({
        checkId: "MCP-005",
        metadata: { actualScope, appId, expectedScope, serverName: "docs", sourceId },
        severity: "warn",
      });
    },
  );

  it("stays silent when every entry is in the file its scope is written to", () => {
    const workspace = workspaceFor({
      appId: CURSOR_ADAPTER_ID,
      desired: [desired("global", CURSOR_ADAPTER_ID)],
      expectedScope: "global",
      ledger: ["docs"],
      servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpGlobal, "global")],
    });

    expect(runChecks([mcp005], workspace).findings).toEqual([]);
  });

  it("names the file an entry is in, not the scope it is labelled with", () => {
    const workspace = workspaceFor({
      appId: CURSOR_ADAPTER_ID,
      expectedScope: "global",
      ledger: ["docs"],
      servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpProject, "project")],
    });
    const finding = runChecks([mcp005], workspace).findings[0];

    expect(finding?.message).toBe(
      "Personal MCP server docs for Cursor is configured in /workspace/.cursor/mcp.json.",
    );
    expect(finding?.details).toContain("inside the repository");
    expect(finding?.locations?.map((location) => location.path)).toEqual([
      "/workspace/.cursor/mcp.json",
      "/home/dev/.cursor/mcp.json",
    ]);
  });

  it("does not duplicate a misplaced server as MCP-001 missing state", () => {
    const workspace = workspaceFor({
      appId: CLAUDE_CODE_ADAPTER_ID,
      expectedScope: "project",
      ledger: ["docs"],
      servers: [server(CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS.mcp, "global")],
    });

    expect(
      runChecks([mcp001, mcp005], workspace).findings.map((finding) => finding.checkId),
    ).toEqual(["MCP-005"]);
  });

  it("keeps MCP-001 missing coverage when the same name is desired in both scopes", () => {
    const workspace = workspaceFor({
      appId: CLAUDE_CODE_ADAPTER_ID,
      desired: [
        desired("global", CLAUDE_CODE_ADAPTER_ID),
        desired("project", CLAUDE_CODE_ADAPTER_ID),
      ],
      expectedScope: "project",
      ledger: ["docs"],
      servers: [server(CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS.mcpProject, "project")],
    });

    expect(
      runChecks([mcp001, mcp005], workspace).findings.map((finding) => [
        finding.checkId,
        finding.id,
      ]),
    ).toEqual([["MCP-001", "missing:claude-code:docs"]]);
  });

  it("ignores unmanifested servers and servers in unmanaged applications", () => {
    const unmanifested = workspaceFor({
      appId: CURSOR_ADAPTER_ID,
      desired: [],
      expectedScope: "global",
      ledger: [],
      servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpProject, "project")],
    });
    const unmanaged = workspaceFor({
      appId: CURSOR_ADAPTER_ID,
      expectedScope: "global",
      ledger: [],
      managed: false,
      servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpProject, "project")],
    });

    expect(runChecks([mcp005], unmanifested).findings).toEqual([]);
    expect(runChecks([mcp005], unmanaged).findings).toEqual([]);
  });
});

// `claude mcp add` files a server under `projects` in ~/.claude.json by default: project scope
// against the global file's spec. Judging placement on the scope label alone made this the one
// arrangement the check got wrong in both directions.
describe("MCP-005 and Claude Code's per-directory entries", () => {
  const local = () => server(CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS.mcp, "project");

  it("does not accuse a personal server in ~/.claude.json of reaching source control", () => {
    const workspace = workspaceFor({
      appId: CLAUDE_CODE_ADAPTER_ID,
      expectedScope: "global",
      ledger: ["docs"],
      servers: [local()],
    });
    const finding = runChecks([mcp005], workspace).findings[0];

    expect(finding?.message).toBe(
      "Personal MCP server docs for Claude Code is configured in /home/dev/.claude.json.",
    );
    expect(finding?.details).toContain("applies only where it is configured");
    expect(finding?.details).not.toContain("repository");
    expect(finding?.details).not.toContain("committed");
  });

  it("reports a team server that only this directory receives", () => {
    const workspace = workspaceFor({
      appId: CLAUDE_CODE_ADAPTER_ID,
      expectedScope: "project",
      ledger: ["docs"],
      servers: [local()],
    });
    const findings = runChecks([mcp001, mcp005], workspace).findings;

    expect(findings.map((finding) => finding.checkId)).toEqual(["MCP-005"]);
    expect(findings[0]?.details).toContain("personal to you");
    expect(findings[0]?.details).toContain("/workspace/.mcp.json");
  });

  it("reports the per-directory entry and the global one separately", () => {
    const workspace = workspaceFor({
      appId: CLAUDE_CODE_ADAPTER_ID,
      expectedScope: "project",
      ledger: ["docs"],
      servers: [local(), server(CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS.mcp, "global")],
    });

    expect(runChecks([mcp005], workspace).findings.map((finding) => finding.id)).toEqual([
      "claude-code:claude-code.mcp.global:docs:project-to-project",
      "claude-code:claude-code.mcp.global:docs:global-to-project",
    ]);
  });
});
