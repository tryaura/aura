import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import claudeCodePlugin from "@tryaura/adapter-claude-code";
import { buildWorkspaceModel, createEnvironment, type WorkspaceScan } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createClaudeCodeSeed, type TestSeed } from "./index.js";

describe("Claude Code versioned fixtures", () => {
  it.each([
    ["2.1.233", "supported"],
    ["3.0.0", "unsupported"],
  ])("feeds Claude Code %s into the workspace model as %s", async (version, support) => {
    if (version !== "2.1.233" && version !== "3.0.0") {
      throw new Error(`Unexpected fixture version: ${version}`);
    }
    await using seed = await createClaudeCodeSeed({ authenticated: true, version });
    const adapter = claudeCodePlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Claude Code plugin did not contribute its adapter.");
    }

    const scan = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createEnvironment({
        cwd: seed.workspaceDir,
        environmentVariables: {},
        homeDir: seed.homeDir,
        path: seed.pathDir,
        platform: "linux",
      }),
    });

    expectClaudeApp(scan, seed, version, support);
    expectClaudeMcp(scan);
    expectClaudeSources(scan, seed);
    await expect(seed.invocations("claude")).resolves.toEqual([["--version"], ["auth", "status"]]);
  });

  it("models an unauthenticated installation without triggering a login flow", async () => {
    await using seed = await createClaudeCodeSeed({ authenticated: false, version: "2.1.233" });
    const adapter = claudeCodePlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Claude Code plugin did not contribute its adapter.");
    }

    const scan = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createEnvironment({
        cwd: seed.workspaceDir,
        environmentVariables: {},
        homeDir: seed.homeDir,
        path: seed.pathDir,
        platform: "linux",
      }),
    });

    expect(scan.model.apps[0]?.detection.authenticated).toBe(false);
    await expect(seed.invocations("claude")).resolves.toEqual([["--version"], ["auth", "status"]]);
  });

  it("reports malformed project MCP JSON as a parse problem, not a filesystem one", async () => {
    await using seed = await createClaudeCodeSeed({ authenticated: true, version: "2.1.233" });
    await writeFile(join(seed.workspaceDir, ".mcp.json"), "{", "utf8");
    const adapter = claudeCodePlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Claude Code plugin did not contribute its adapter.");
    }

    const scan = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createEnvironment({
        cwd: seed.workspaceDir,
        environmentVariables: {},
        homeDir: seed.homeDir,
        path: seed.pathDir,
        platform: "linux",
      }),
    });

    // The file read fine; it is the contents the adapter cannot use, and saying nothing would
    // leave a user whose MCP servers stopped working with no reason for it.
    expect(scan.diagnostics).toEqual([
      {
        adapterId: "claude-code",
        message: `Claude Code's MCP configuration at ${seed.workspaceDir}/.mcp.json is not a valid JSON object, so none of the servers it declares are loading — in Claude Code either. Fix the file to restore them.`,
        path: `${seed.workspaceDir}/.mcp.json`,
        phase: "parse",
      },
    ]);
    expect(scan.model.mcpServers.map((server) => server.name)).not.toContain("projectDocs");
    expect(
      scan.model.apps[0]?.sourceFiles.find((file) => file.spec.id === "claude-code.mcp.project"),
    ).toEqual({
      exists: true,
      pathKind: "file",
      problem: undefined,
      spec: {
        id: "claude-code.mcp.project",
        kind: "mcp",
        optional: true,
        path: `${seed.workspaceDir}/.mcp.json`,
        scope: "project",
      },
    });
  });
});

function expectClaudeApp(
  scan: WorkspaceScan,
  seed: TestSeed,
  version: string,
  support: string,
): void {
  expect(scan.diagnostics).toEqual([]);
  expect(scan.model.apps).toHaveLength(1);
  expect(scan.model.apps[0]?.detection).toEqual({
    authenticated: true,
    executablePath: `${seed.pathDir}/claude`,
    installed: true,
    version,
  });
  expect(scan.model.apps[0]?.support).toEqual({
    status: support,
    supportedRange: ">=2.1.0 <3.0.0",
    version,
  });
  // The mention and the package name in the fixture are prose, not imports.
  expect(scan.model.instructionFiles[0]?.links).toEqual([
    { kind: "import", targetPath: `${seed.homeDir}/agents/AGENTS.md`, valid: true },
    { kind: "import", targetPath: `${seed.homeDir}/.claude/team.md`, valid: true },
  ]);
  expect(scan.model.instructionFiles[1]).toMatchObject({
    links: [
      { kind: "import", targetPath: `${seed.workspaceDir}/docs/project.md`, valid: true },
      { kind: "import", targetPath: `${seed.homeDir}/agents/AGENTS.md`, valid: true },
    ],
    path: `${seed.workspaceDir}/CLAUDE.md`,
    scope: "project",
    sourceId: "claude-code.instructions.project",
  });
}

function expectClaudeMcp(scan: WorkspaceScan): void {
  expect(scan.model.mcpServers.map((server) => server.name)).toEqual([
    "docs",
    "legacy",
    "sentry",
    "streaming",
    "projectDocs",
    "local",
  ]);
  expect(scan.model.mcpServers.map((server) => server.transport)).toEqual([
    {
      args: ["-y", "@example/docs-mcp"],
      command: "npx",
      environmentVariables: ["DOCS_TOKEN"],
      type: "stdio",
    },
    {
      args: ["@example/legacy-mcp", "--api-key", "[redacted]"],
      command: "npx",
      type: "stdio",
    },
    {
      headerEnvironmentVariables: ["SENTRY_TOKEN"],
      type: "http",
      url: "https://mcp.sentry.dev/",
    },
    { type: "sse", url: "https://sse.example.com/mcp?token=[redacted]" },
    {
      args: ["--project"],
      command: "project-docs-server",
      environmentVariables: ["PROJECT_TOKEN"],
      type: "stdio",
    },
    {
      headerEnvironmentVariables: ["LOCAL_TOKEN"],
      type: "http",
      url: "https://local.example.com/mcp?token=[redacted]",
    },
  ]);
  expect(
    scan.model.mcpServers.map((server) => [server.name, server.scope, server.sourceId]),
  ).toEqual([
    ["docs", "global", "claude-code.mcp.global"],
    ["legacy", "global", "claude-code.mcp.global"],
    ["sentry", "global", "claude-code.mcp.global"],
    ["streaming", "global", "claude-code.mcp.global"],
    ["projectDocs", "project", "claude-code.mcp.project"],
    // Local scope: project-scoped, but declared in — and edited in — the global file.
    ["local", "project", "claude-code.mcp.global"],
  ]);
  // Every server names a file the adapter declared, so a check can turn one back into a path.
  const declared = new Set(scan.model.apps[0]?.sourceFiles.map((file) => file.spec.id));
  expect(scan.model.mcpServers.every((server) => declared.has(server.sourceId))).toBe(true);
  expect(JSON.stringify(scan.model.mcpServers)).not.toContain("sk-fixture-secret");
  expect(JSON.stringify(scan.model.mcpServers)).not.toContain("sk-local-secret");
}

function expectClaudeSources(scan: WorkspaceScan, seed: TestSeed): void {
  expect(scan.model.apps[0]?.sourceFiles.map((file) => file.spec.path)).toEqual([
    `${seed.homeDir}/.claude/CLAUDE.md`,
    `${seed.workspaceDir}/CLAUDE.md`,
    `${seed.homeDir}/.claude.json`,
    `${seed.workspaceDir}/.mcp.json`,
    `${seed.homeDir}/.claude/settings.json`,
    `${seed.workspaceDir}/.claude/settings.json`,
  ]);
  expect(scan.model.apps[0]?.metadata).toEqual({
    claudePermissions: { global: { allowCount: 1 } },
  });
}
