import cursorPlugin from "@tryaura/adapter-cursor";
import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createCursorSeed } from "./index.js";

describe("Cursor versioned fixtures", () => {
  it.each([
    ["3.11.0", "supported"],
    ["4.0.0", "unsupported"],
  ])("feeds Cursor %s into the workspace model as %s", async (version, support) => {
    if (version !== "3.11.0" && version !== "4.0.0") {
      throw new Error(`Unexpected fixture version: ${version}`);
    }
    await using seed = await createCursorSeed({ rules: "current", version });
    const adapter = cursorPlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Cursor plugin did not contribute its adapter.");
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
      executablePath: `${seed.pathDir}/cursor`,
      installed: true,
      version,
    });
    expect(scan.model.apps[0]?.support).toEqual({
      status: support,
      supportedRange: ">=0.45.0 <4.0.0",
      version,
    });
    expect(
      scan.model.instructionFiles.map((document) => ({
        path: document.path,
        scope: document.scope,
      })),
    ).toEqual([
      { path: `${seed.workspaceDir}/AGENTS.md`, scope: "project" },
      { path: `${seed.workspaceDir}/.cursor/rules/project.mdc`, scope: "project" },
      {
        path: `${seed.workspaceDir}/.cursor/rules/backend/database.mdc`,
        scope: "project",
      },
    ]);
    expect(scan.model.instructionFiles.map((document) => document.metadata)).toEqual([
      undefined,
      { alwaysApply: true },
      { alwaysApply: false, description: "Database conventions" },
    ]);
    expect(scan.model.instructionFiles.flatMap((document) => document.links)).toEqual([
      {
        kind: "import",
        targetPath: `${seed.workspaceDir}/.cursor/rules/project-template.ts`,
        valid: true,
      },
      {
        kind: "import",
        targetPath: `${seed.workspaceDir}/.cursor/rules/backend/schema.sql`,
        valid: true,
      },
    ]);
    expect(scan.model.mcpServers.map((server) => [server.name, server.scope])).toEqual([
      ["docs", "global"],
      ["sentry", "project"],
    ]);
    expect(scan.model.mcpServers.map((server) => server.transport)).toEqual([
      {
        args: ["-y", "@example/docs-mcp"],
        command: "npx",
        environmentVariables: ["DOCS_TOKEN"],
        type: "stdio",
      },
      {
        headerEnvironmentVariables: ["SENTRY_TOKEN"],
        type: "http",
        url: "https://mcp.sentry.dev/mcp?token=[redacted]",
      },
    ]);
    expect(JSON.stringify(scan.model.mcpServers)).not.toContain("sk-fixture-secret");
    expect(
      scan.model.instructionFiles.some((document) => document.path.endsWith("ignored.md")),
    ).toBe(false);
    await expect(seed.invocations("cursor")).resolves.toEqual([["--version"]]);
  });

  it("recognizes the legacy project file as an instruction source for migration checks", async () => {
    await using seed = await createCursorSeed({ rules: "legacy", version: "3.11.0" });
    const adapter = cursorPlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Cursor plugin did not contribute its adapter.");
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
    expect(scan.model.instructionFiles).toEqual([
      {
        canonicalPath: `${seed.workspaceDir}/.cursorrules`,
        content: "# Legacy Cursor instructions\n\nUse the repository conventions.\n",
        links: [],
        path: `${seed.workspaceDir}/.cursorrules`,
        scope: "project",
        sourceId: "cursor.rules.project.legacy",
      },
    ]);
  });
});
