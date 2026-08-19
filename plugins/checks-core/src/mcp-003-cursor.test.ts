import type { JsonObject, McpServer, WorkspaceModel } from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { mcp003 } from "./mcp-003.js";
import { app, model } from "./testing.js";

describe("MCP-003 Cursor runtime state", () => {
  it.each([
    ["needs-approval", "approve server docs"],
    ["disabled", "enable server docs"],
    ["error", "inspect the connection error for server docs"],
  ] as const)("warns when Cursor reports a configured server as %s", (state, guidance) => {
    const workspace = cursorWorkspace(state);
    const finding = runChecks([mcp003], workspace).findings[0];

    expect(finding).toMatchObject({
      checkId: "MCP-003",
      // Approval and enablement are Cursor's own, so the finding downgrades the check's guided
      // fixability: a wizard question here can only repeat the detail and leave the state as it
      // was, which is what made the same servers reappear run after run.
      fixability: "manual",
      metadata: {
        appId: "cursor",
        kind: "cursor-state",
        serverName: "docs",
        state,
      },
      // Including `error`: Cursor reports one for a server that was merely unreachable when it
      // looked, and none of this is gated behind `--online`.
      severity: "warn",
    });
    expect(finding?.message).toContain("docs");
    expect(finding?.message).toContain("Cursor");
    expect(finding?.details).toContain(guidance);
    if (finding === undefined) {
      throw new Error("Expected a Cursor MCP state finding.");
    }
    expect(mcp003.guidedFixes?.(finding, workspace)).toEqual([]);
  });

  it("does not duplicate a concrete failure with Cursor's connection state", () => {
    const workspace = cursorWorkspace("error", {
      ...cursorServer(),
      probes: [{ kind: "command", status: "error" }],
    });

    const findings = runChecks([mcp003], workspace).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.metadata?.["kind"]).toBe("command");
  });

  it("stays silent for a server Cursor reports as ready", () => {
    expect(runChecks([mcp003], cursorWorkspace("ready")).findings).toEqual([]);
  });

  it("reports a status line it could not understand rather than passing the server", () => {
    // The states come out of a table meant for a terminal. A format change turns every row
    // `unknown`, and silence there would read as a clean bill of health.
    const workspace = cursorWorkspace("unknown");
    const finding = runChecks([mcp003], workspace).findings[0];
    if (finding === undefined) {
      throw new Error("Expected an unreadable-state finding.");
    }

    expect(finding).toMatchObject({
      fixability: "manual",
      metadata: { appId: "cursor", kind: "cursor-state-unreadable", serverName: "docs" },
      severity: "info",
    });
    // Nothing to offer: Aura does not know what is wrong, only that it could not tell.
    expect(mcp003.guidedFixes?.(finding, workspace)).toEqual([]);
  });

  it.each([
    ["timeout", "did not finish in time"],
    ["failed", "exited unsuccessfully"],
  ])("says once when the listing was attempted and %s", (reason, cause) => {
    const workspace = cursorWorkspace(undefined, cursorServer(), {
      mcpRuntimeStatesUnavailable: reason,
    });
    const findings = runChecks([mcp003], workspace).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      fixability: "manual",
      metadata: { appId: "cursor", kind: "cursor-state-unavailable", reason },
      severity: "info",
    });
    expect(findings[0]?.message).toContain(cause);
  });

  it("stays silent when the companion CLI never ran", () => {
    expect(runChecks([mcp003], cursorWorkspace(undefined)).findings).toEqual([]);
  });
});

function cursorWorkspace(
  state: "ready" | "needs-approval" | "disabled" | "error" | "unknown" | undefined,
  server: McpServer = cursorServer(),
  metadata: JsonObject = state === undefined
    ? {}
    : { mcpRuntimeStates: { docs: state, unconfigured: "needs-approval" } },
): WorkspaceModel {
  const application = app({
    adapterId: "cursor",
    displayName: "Cursor",
    mcpServers: [server],
  });
  return model({
    apps: [
      {
        ...application,
        detection: { ...application.detection, metadata },
      },
    ],
  });
}

function cursorServer(): McpServer {
  return {
    appId: "cursor",
    name: "docs",
    scope: "global",
    sourceId: "cursor.mcp.global",
    transport: { args: ["@example/docs"], command: "npx", type: "stdio" },
  };
}
