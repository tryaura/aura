import type {
  Finding,
  GuidedFixChoice,
  McpProbeStatus,
  McpServer,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { parseAuraManifest, runChecks } from "@tryaura/core";
import type { AppMcpConvergence } from "@tryaura/core/testing";
import { describe, expect, it } from "vitest";

import { mcp003 } from "./mcp-003.js";
import { app, model } from "./testing.js";

describe("MCP-003", () => {
  it.each(["ok", "unsupported", "unavailable", "unknown"] satisfies readonly McpProbeStatus[])(
    "stays silent for %s probes",
    (probeStatus) => {
      const workspace = workspaceFor(serverWithProbe("command", probeStatus));

      expect(runChecks([mcp003], workspace).findings).toEqual([]);
    },
  );

  it("reports only a probe that ran and returned an error", () => {
    const workspace = workspaceFor(serverWithProbe("command", "error"));
    const finding = runChecks([mcp003], workspace).findings[0];

    expect(finding).toMatchObject({
      checkId: "MCP-003",
      locations: [{ path: "/home/dev/.claude.json" }],
      metadata: {
        appId: "claude-code",
        kind: "command",
        serverName: "docs",
        sourceId: "claude-code.mcp.global",
      },
      severity: "error",
    });
  });

  it("warns rather than fails when the probe may not repeat", () => {
    const server = serverWithProbe("url", "error", "http");
    const workspace = workspaceFor({
      ...server,
      probes: [
        {
          detail: "The URL responded with HTTP 503.",
          kind: "url",
          status: "error",
          transient: true,
        },
      ],
    });

    expect(runChecks([mcp003], workspace).findings[0]).toMatchObject({
      checkId: "MCP-003",
      severity: "warn",
    });
  });

  it("offers transport-specific repair instructions", () => {
    const commandWorkspace = workspaceFor(serverWithProbe("command", "error"));
    const urlWorkspace = workspaceFor(serverWithProbe("url", "error", "http"));

    expect(choice(commandWorkspace, "repair").plan.manualSteps).toContain(
      "Run `aura check` again.",
    );
    expect(choice(urlWorkspace, "repair").plan.manualSteps).toContain(
      "Run `aura check --online` again.",
    );
  });

  it("keeps foreign removals manual and names the source file", () => {
    const workspace = workspaceFor(serverWithProbe("command", "error"));
    const remove = choice(workspace, "remove");

    expect(remove.plan.operations).toEqual([]);
    expect(remove.plan.manualSteps?.join("\n")).toContain("/home/dev/.claude.json");
    expect(remove.plan.manualSteps?.join("\n")).toContain("ownership ledger");
  });

  // fallow-ignore-next-line complexity -- one assertion follows both operation unions through the atomic plan.
  it("removes an owned server from config, ledger, and manifest atomically", () => {
    const server = serverWithProbe("command", "error");
    const convergence: AppMcpConvergence = (desired) => ({
      blockers: [],
      operations: [
        {
          content: JSON.stringify({ desired }),
          path: "/home/dev/.claude.json",
          type: "write",
        },
      ],
      ownedNames: desired.map((entry) => entry.name),
    });
    const workspace = workspaceFor(server, {
      convergence,
      manifest: readyManifest(["claude-code", "codex"], ["docs"]),
    });
    const remove = choice(workspace, "remove");

    expect(
      remove.plan.operations.map((operation) =>
        operation.type === "write" ? operation.path : "unexpected operation",
      ),
    ).toEqual(["/home/dev/.claude.json", "/home/dev/agents/aura.json"]);
    const config = remove.plan.operations[0];
    expect(config?.type === "write" ? JSON.parse(config.content) : undefined).toEqual({
      desired: [],
    });
    const manifestWrite = remove.plan.operations[1];
    const parsed =
      manifestWrite?.type === "write"
        ? parseAuraManifest(manifestWrite.content, manifestWrite.path)
        : undefined;
    expect(parsed?.status === "ready" ? parsed.value.mcpServers[0]?.apps : undefined).toEqual([
      "codex",
    ]);
    expect(
      parsed?.status === "ready"
        ? parsed.value.ownership["claude-code"]?.mcpServerNames
        : undefined,
    ).toEqual([]);
  });

  it("drops the manifest server when removal leaves it with no applications", () => {
    const server = serverWithProbe("command", "error");
    const convergence: AppMcpConvergence = (desired) => ({
      blockers: [],
      operations: [],
      ownedNames: desired.map((entry) => entry.name),
    });
    const workspace = workspaceFor(server, {
      convergence,
      manifest: readyManifest(["claude-code"], ["docs"]),
    });
    const manifestWrite = choice(workspace, "remove").plan.operations[0];
    const parsed =
      manifestWrite?.type === "write"
        ? parseAuraManifest(manifestWrite.content, manifestWrite.path)
        : undefined;

    expect(parsed?.status === "ready" ? parsed.value.mcpServers : undefined).toEqual([]);
  });

  it("keeps duplicate configured identities manual", () => {
    const server = serverWithProbe("command", "error");
    const workspace = workspaceFor(server, {
      convergence: () => ({ blockers: [], operations: [], ownedNames: [] }),
      manifest: readyManifest(["claude-code"], ["docs"]),
      servers: [server, { ...server }],
    });
    const remove = choice(workspace, "remove");

    expect(remove.plan.operations).toEqual([]);
    expect(remove.plan.manualSteps?.join("\n")).toContain("more than one configured");
  });
});

function workspaceFor(
  server: McpServer,
  options: {
    readonly convergence?: AppMcpConvergence;
    readonly manifest?: WorkspaceModel["manifest"];
    readonly servers?: readonly McpServer[];
  } = {},
): WorkspaceModel {
  const application = app({
    adapterId: "claude-code",
    displayName: "Claude Code",
    ...(options.convergence === undefined ? {} : { mcpConvergence: options.convergence }),
    mcpServers: options.servers ?? [server],
    sources: [
      {
        exists: true,
        spec: {
          id: "claude-code.mcp.global",
          kind: "mcp",
          path: "/home/dev/.claude.json",
          scope: "global",
        },
      },
    ],
  });
  return model({
    apps: [application],
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
  });
}

function serverWithProbe(
  kind: "command" | "url",
  status: McpProbeStatus,
  transport: "http" | "stdio" = "stdio",
): McpServer {
  return {
    appId: "claude-code",
    name: "docs",
    probes: [{ detail: "probe detail", kind, status }],
    scope: "global",
    sourceId: "claude-code.mcp.global",
    transport:
      transport === "stdio"
        ? { args: ["@example/docs"], command: "npx", type: "stdio" }
        : { type: "http", url: "https://example.test/mcp" },
  };
}

function readyManifest(
  apps: readonly string[],
  ownership: readonly string[],
): WorkspaceModel["manifest"] {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: { "claude-code": { managed: true }, codex: { managed: true } },
      mcpServers: [
        {
          apps,
          name: "docs",
          transport: { args: ["@example/docs"], command: "npx", type: "stdio" },
        },
      ],
      ownership: {
        "claude-code": { files: [], mcpServerNames: ownership },
        codex: { files: [], mcpServerNames: ["docs"] },
      },
      schemaVersion: 1,
      skills: [],
      snippets: [],
    },
  };
}

function choice(workspace: WorkspaceModel, id: string): GuidedFixChoice {
  const finding = runChecks([mcp003], workspace).findings[0];
  if (finding === undefined) {
    throw new Error("Expected MCP-003 to report a finding.");
  }
  return choiceFor(finding, workspace, id);
}

function choiceFor(finding: Finding, workspace: WorkspaceModel, id: string): GuidedFixChoice {
  const selected = mcp003
    .guidedFixes?.(finding, workspace)
    .find((candidate) => candidate.id === id);
  if (selected === undefined) {
    throw new Error(`Expected guided choice ${id}.`);
  }
  return selected;
}
