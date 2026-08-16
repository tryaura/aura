import codexPlugin from "@tryaura/adapter-codex";
import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createCodexSeed, type CodexFixtureVersion } from "./index.js";

describe("Codex versioned fixtures", () => {
  it.each([
    ["0.146.0", "supported"],
    ["0.147.0", "supported"],
    ["0.148.0", "unsupported"],
  ] satisfies readonly (readonly [CodexFixtureVersion, "supported" | "unsupported"])[])(
    "feeds Codex %s into the workspace model as %s",
    async (version, support) => {
      await using seed = await createCodexSeed({ authenticated: true, version });
      const adapter = codexPlugin.adapters?.[0];
      if (adapter === undefined) {
        throw new Error("Codex plugin did not contribute its adapter.");
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
        executablePath: `${seed.pathDir}/codex`,
        installed: true,
        version,
      });
      expect(scan.model.apps[0]?.support).toEqual({
        status: support,
        supportedRange: ">=0.146.0 <0.148.0",
        version,
      });
      expect(scan.model.instructionFiles[0]?.links).toEqual([]);
      expect(scan.model.apps[0]?.sharedLink).toEqual({
        entryPath: `${seed.homeDir}/.codex/AGENTS.md`,
        kind: "symlink",
        scope: "global",
      });
      expect(scan.model.mcpServers.map((server) => server.name)).toEqual([
        "docs",
        "legacy",
        "sentry",
      ]);
      expect(scan.model.mcpServers.map((server) => server.transport)).toEqual([
        {
          args: ["-y", "@example/docs-mcp"],
          command: "npx",
          environmentVariables: ["DOCS_TOKEN", "LOCAL_TOKEN", "REMOTE_TOKEN"],
          type: "stdio",
        },
        {
          args: ["@example/legacy-mcp", "--api-key", "[redacted]"],
          command: "npx",
          type: "stdio",
        },
        {
          headerEnvironmentVariables: ["AUTH_TOKEN", "SENTRY_TOKEN"],
          type: "http",
          url: "https://mcp.sentry.dev/mcp?token=[redacted]",
        },
      ]);
      const serialized = JSON.stringify(scan.model.mcpServers);
      expect(serialized).not.toContain("sk-fixture-secret");
      expect(serialized).not.toContain("inline-fixture-secret");
      expect(scan.model.apps[0]?.sourceFiles.map((file) => file.spec.path)).toEqual([
        `${seed.homeDir}/.codex/AGENTS.md`,
        `${seed.homeDir}/.codex/config.toml`,
      ]);
      await expect(seed.invocations("codex")).resolves.toEqual([
        ["--version"],
        ["login", "status"],
      ]);
    },
  );

  it("models an unauthenticated installation without triggering a login flow", async () => {
    await using seed = await createCodexSeed({ authenticated: false, version: "0.147.0" });
    const adapter = codexPlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Codex plugin did not contribute its adapter.");
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
    await expect(seed.invocations("codex")).resolves.toEqual([["--version"], ["login", "status"]]);
  });
});
