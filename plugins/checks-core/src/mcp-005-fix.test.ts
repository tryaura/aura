import { CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS } from "@tryaura/adapter-claude-code";
import { CODEX_ADAPTER_ID, CODEX_SOURCE_IDS } from "@tryaura/adapter-codex";
import { CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS } from "@tryaura/adapter-cursor";
import { describe, expect, it } from "vitest";

import {
  opposite,
  placementPlan,
  placementSteps,
  PLACEMENTS,
  server,
  workspaceFor,
} from "./mcp-005-fixtures.js";

describe("MCP-005 remediation", () => {
  it.each(PLACEMENTS)(
    "moves $appId toward $expectedScope scope automatically: $automatic",
    ({ appId, automatic, expectedScope, sourceId }) => {
      const plan = placementPlan(
        workspaceFor({
          appId,
          expectedScope,
          ledger: ["docs"],
          servers: [server(appId, sourceId, opposite(expectedScope))],
        }),
      );

      expect(plan?.operations.length === 0).toBe(!automatic);
      expect(plan?.summary).toContain(automatic ? "Move MCP server docs into" : "manually");
    },
  );

  it("names the move rather than the whole-application convergence it borrows", () => {
    const plan = placementPlan(
      workspaceFor({
        appId: CURSOR_ADAPTER_ID,
        expectedScope: "global",
        ledger: ["docs"],
        servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpProject, "project")],
      }),
    );

    expect(plan?.summary).toBe("Move MCP server docs into Cursor's global MCP configuration.");
    expect(plan?.operations.length).toBeGreaterThan(0);
  });

  it("leaves a foreign entry untouched and names both configuration files", () => {
    const workspace = workspaceFor({
      appId: CURSOR_ADAPTER_ID,
      expectedScope: "global",
      ledger: [],
      servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpProject, "project")],
    });
    const steps = placementSteps(workspace);

    expect(placementPlan(workspace)?.operations).toEqual([]);
    expect(steps).toContain("outside Aura's ownership ledger");
    expect(steps).toContain("Remove MCP server docs from /workspace/.cursor/mcp.json.");
    expect(steps).toContain("Add MCP server docs to /home/dev/.cursor/mcp.json");
  });

  it("asks for one move within the file when both ends are the same file", () => {
    const steps = placementSteps(
      workspaceFor({
        appId: CLAUDE_CODE_ADAPTER_ID,
        expectedScope: "global",
        ledger: ["docs"],
        servers: [server(CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS.mcp, "project")],
      }),
    );

    expect(steps).toContain(
      "Move MCP server docs within /home/dev/.claude.json into the entries Claude Code applies at global scope",
    );
    expect(steps).toContain("Aura rewrites only the project-scope entries it manages");
    expect(steps).not.toContain("Remove MCP server docs from /home/dev/.claude.json.");
  });

  // The reason Aura declined has to be the reason it actually declined: an owned entry in the file
  // Aura manages was previously told its source was non-canonical, which sends the reader to
  // inspect a file that is fine.
  it("blames the convergence blocker, not the source file, when an application cannot converge", () => {
    const steps = placementSteps(
      workspaceFor({
        appId: CURSOR_ADAPTER_ID,
        blockers: [{ message: "Cursor's MCP configuration could not be parsed." }],
        expectedScope: "global",
        ledger: ["docs"],
        servers: [server(CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS.mcpProject, "project")],
      }),
    );

    expect(steps).toContain("Cursor's MCP configuration could not be parsed.");
    expect(steps).toContain("cannot converge that configuration safely");
    expect(steps).not.toContain("Aura rewrites only");
    expect(steps).not.toContain("ownership ledger");
  });

  it("explains an unsupported project scope instead of naming a destination that cannot exist", () => {
    const steps = placementSteps(
      workspaceFor({
        appId: CODEX_ADAPTER_ID,
        expectedScope: "project",
        ledger: ["docs"],
        servers: [server(CODEX_ADAPTER_ID, CODEX_SOURCE_IDS.mcp, "global")],
      }),
    );

    expect(steps).toContain("Codex has no project-scope MCP configuration target");
    expect(steps).toContain("change server docs to global scope in /home/dev/agents/aura.json");
    expect(steps).not.toContain("Add MCP server docs to");
  });

  it("keeps the unsupported-scope explanation for an entry Aura does not own", () => {
    const steps = placementSteps(
      workspaceFor({
        appId: CODEX_ADAPTER_ID,
        expectedScope: "project",
        ledger: [],
        servers: [server(CODEX_ADAPTER_ID, CODEX_SOURCE_IDS.mcp, "global")],
      }),
    );

    expect(steps).toContain("Codex has no project-scope MCP configuration target");
  });
});
