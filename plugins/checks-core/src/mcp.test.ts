/* eslint-disable max-lines -- the MCP parity matrix shares one desired-state fixture. */
import type {
  AuraManifest,
  AuraManifestMcpServer,
  McpServer,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";
import type { AppMcpConvergence, AppMcpConvergenceResult } from "@tryaura/core/testing";
import { describe, expect, it } from "vitest";

import { mcp001 } from "./mcp-001.js";
import { mcp002 } from "./mcp-002.js";
import { app, model } from "./testing.js";

const DOCS: AuraManifestMcpServer = {
  apps: ["claude-code"],
  name: "docs",
  transport: { args: ["-y", "@example/docs"], command: "npx", env: ["TOKEN"], type: "stdio" },
};

describe("MCP-001 and MCP-002", () => {
  it("reports preset-required virtual servers with requirement provenance", () => {
    const base = workspaceFor({ convergence: readyConvergence(), desired: [], servers: [] });
    const workspace: WorkspaceModel = {
      ...base,
      requiredMcpServers: [
        {
          apps: ["claude-code"],
          catalogId: "official/docs",
          name: "docs",
          requiredBy: "Acme platform",
          transport: DOCS.transport,
        },
      ],
    };

    expect(runChecks([mcp001], workspace).findings[0]).toMatchObject({
      id: "missing:claude-code:docs",
      metadata: { requiredBy: "Acme platform" },
    });
  });

  it("reports an explicit preset override as informational without creating a desired target", () => {
    const base = workspaceFor({ convergence: readyConvergence(), desired: [], servers: [] });
    const workspace: WorkspaceModel = {
      ...base,
      overriddenRequiredMcpServers: [{ catalogId: "official/docs", requiredBy: "Acme platform" }],
    };

    expect(runChecks([mcp001], workspace).findings).toEqual([
      expect.objectContaining({
        id: "override:official/docs",
        metadata: {
          catalogId: "official/docs",
          kind: "preset-override",
          requiredBy: "Acme platform",
        },
        severity: "info",
      }),
    ]);
  });

  it("reports and fixes a missing manifest server", () => {
    const workspace = workspaceFor({ convergence: readyConvergence(), servers: [] });
    const finding = runChecks([mcp001], workspace).findings[0];

    expect(finding).toMatchObject({
      id: "missing:claude-code:docs",
      metadata: { appId: "claude-code", kind: "missing" },
    });
    const plan = finding === undefined ? undefined : mcp001.fix(finding, workspace);
    expect(
      plan?.operations.map((operation) => (operation.type === "write" ? operation.path : "")),
    ).toEqual(["/home/dev/.claude.json", "/home/dev/agents/aura.json"]);
  });

  it("cleans stale ownership even when the server is already absent", () => {
    const workspace = workspaceFor({
      convergence: () => ({ blockers: [], operations: [], ownedNames: [] }),
      ledger: ["old"],
      servers: [],
      desired: [],
    });
    const finding = runChecks([mcp001], workspace).findings[0];
    const plan = finding === undefined ? undefined : mcp001.fix(finding, workspace);

    expect(finding?.id).toBe("stale:claude-code:old");
    expect(plan?.operations).toHaveLength(1);
    expect(plan?.operations[0]?.type === "write" ? plan.operations[0].path : "").toBe(
      "/home/dev/agents/aura.json",
    );
    expect(plan?.operations[0]?.type === "write" ? plan.operations[0].content : "").not.toContain(
      '"old"',
    );
  });

  it.each([
    ["command", stdio({ command: "bunx" })],
    ["args", stdio({ args: ["@example/other"] })],
    ["environment names", stdio({ environmentVariables: ["OTHER"] })],
    ["URL", http({ url: "https://other.example.com/mcp" })],
    ["header names", http({ headerEnvironmentVariables: ["OTHER"] })],
  ])("reports %s drift", (_field, server) => {
    const desired = server.transport.type === "stdio" ? DOCS : remoteDesired();
    const workspace = workspaceFor({
      convergence: readyConvergence(),
      desired: [desired],
      servers: [server],
    });

    expect(runChecks([mcp002], workspace).findings[0]).toMatchObject({
      id: `drift:claude-code:${desired.name}`,
      metadata: { appId: "claude-code", kind: "drift" },
    });
  });

  it("accepts normalized matching transports and redacted credential positions", () => {
    const matching = stdio({
      args: ["-y", "@example/docs"],
      environmentVariables: ["TOKEN"],
    });
    const workspace = workspaceFor({ convergence: readyConvergence(), servers: [matching] });

    expect(runChecks([mcp001, mcp002], workspace).findings).toEqual([]);
  });

  it("reports a declared but disabled entry instead of calling it missing", () => {
    const workspace = workspaceFor({
      convergence: readyConvergence(),
      servers: [],
      unusable: [
        {
          appId: "claude-code",
          name: "docs",
          reason: "disabled",
          scope: "global",
          sourceId: "claude-code.mcp.global",
        },
      ],
    });

    expect(runChecks([mcp001], workspace).findings[0]).toMatchObject({
      fixability: "manual",
      id: "unusable:claude-code:docs",
      metadata: { kind: "disabled" },
    });
  });

  it("reports an inline credential where the manifest names a variable", () => {
    const workspace = workspaceFor({
      convergence: readyConvergence(),
      servers: [stdio({ inlineCredentialValues: true })],
    });

    expect(runChecks([mcp002], workspace).findings[0]).toMatchObject({
      id: "drift:claude-code:docs",
      metadata: { kind: "inline-credential" },
    });
  });

  it("leaves the blockers to one check rather than reporting them twice", () => {
    const blocked = workspaceFor({
      convergence: () => ({
        blockers: [{ message: "The same name belongs to the user." }],
        operations: [],
        ownedNames: [],
      }),
      servers: [stdio({ command: "different" })],
    });

    expect(runChecks([mcp002], blocked).findings.map((finding) => finding.id)).toEqual([
      "drift:claude-code:docs",
    ]);
    expect(
      runChecks([mcp001, mcp002], blocked).findings.filter((finding) =>
        finding.id.startsWith("blocker:"),
      ),
    ).toHaveLength(1);
  });

  it("says nothing about an application this machine does not have", () => {
    const absent = workspaceFor({ includeApp: false, servers: [] });

    expect(runChecks([mcp001, mcp002], absent).findings).toEqual([]);
  });

  it("downgrades findings whose application cannot converge to manual", () => {
    const collision = workspaceFor({
      convergence: () => ({
        blockers: [{ message: "The same name belongs to the user." }],
        operations: [],
        ownedNames: [],
      }),
      servers: [stdio({ command: "different" })],
    });
    expect(runChecks([mcp002], collision).findings.map((finding) => finding.fixability)).toEqual([
      "manual",
    ]);
  });
});

function workspaceFor(options: {
  readonly convergence?: AppMcpConvergence;
  readonly desired?: readonly AuraManifestMcpServer[];
  readonly includeApp?: boolean;
  readonly ledger?: readonly string[];
  readonly servers: readonly McpServer[];
  readonly unusable?: WorkspaceModel["unusableMcpServers"];
}) {
  const manifest = manifestWith(options.desired ?? [DOCS], options.ledger ?? []);
  const apps =
    options.includeApp === false
      ? []
      : [
          app({
            adapterId: "claude-code",
            displayName: "Claude Code",
            ...(options.convergence === undefined ? {} : { mcpConvergence: options.convergence }),
            mcpServers: options.servers,
            ...(options.unusable === undefined ? {} : { unusableMcpServers: options.unusable }),
          }),
        ];
  return model({
    apps,
    manifest: {
      exists: true,
      path: "/home/dev/agents/aura.json",
      status: "ready",
      value: manifest,
    },
  });
}

function manifestWith(
  mcpServers: readonly AuraManifestMcpServer[],
  ledger: readonly string[],
): AuraManifest {
  return {
    apps: { "claude-code": { managed: true } },
    mcpServers,
    ownership: { "claude-code": { files: [], mcpServerNames: ledger } },
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}

function readyConvergence(): AppMcpConvergence {
  return (desired: Parameters<AppMcpConvergence>[0]): AppMcpConvergenceResult => ({
    blockers: [],
    operations: [
      { content: JSON.stringify(desired), path: "/home/dev/.claude.json", type: "write" },
    ],
    ownedNames: desired.map((entry: { readonly name: string }) => entry.name),
  });
}

function stdio(
  overrides: Partial<Extract<McpServer["transport"], { readonly type: "stdio" }>> = {},
): McpServer {
  return {
    appId: "claude-code",
    name: "docs",
    scope: "global",
    sourceId: "claude-code.mcp.global",
    transport: {
      args: ["-y", "@example/docs"],
      command: "npx",
      environmentVariables: ["TOKEN"],
      type: "stdio",
      ...overrides,
    },
  };
}

function http(
  overrides: Partial<Extract<McpServer["transport"], { readonly type: "http" | "sse" }>> = {},
): McpServer {
  return {
    appId: "claude-code",
    name: "remote",
    scope: "global",
    sourceId: "claude-code.mcp.global",
    transport: {
      headerEnvironmentVariables: ["TOKEN"],
      type: "http",
      url: "https://example.com/mcp",
      ...overrides,
    },
  };
}

function remoteDesired(): AuraManifestMcpServer {
  return {
    apps: ["claude-code"],
    name: "remote",
    transport: {
      headers: { Authorization: "Bearer ${TOKEN}" },
      type: "http",
      url: "https://example.com/mcp",
    },
  };
}
