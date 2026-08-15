import claudeCodePlugin from "@tryaura/adapter-claude-code";
import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createClaudeCodeSeed } from "./index.js";

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
    expect(scan.model.mcpServers.map((server) => server.name)).toEqual([
      "docs",
      "legacy",
      "sentry",
      "streaming",
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
    ]);
    // The one property that has to hold across the whole read path.
    expect(JSON.stringify(scan.model.mcpServers)).not.toContain("sk-fixture-secret");
    // settings.json sits in the fixture home and is deliberately not declared.
    expect(scan.model.apps[0]?.sourceFiles.map((file) => file.spec.path)).toEqual([
      `${seed.homeDir}/.claude/CLAUDE.md`,
      `${seed.homeDir}/.claude.json`,
    ]);
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
});
