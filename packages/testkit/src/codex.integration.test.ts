import { join } from "node:path";

import codexPlugin from "@tryaura/adapter-codex";
import { buildWorkspaceModel, createEnvironment } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { CODEX_NESTED_PACKAGE, createCodexSeed, type CodexFixtureVersion } from "./index.js";

describe("Codex versioned fixtures", () => {
  it.each([
    ["0.146.0", "supported"],
    ["0.147.0", "supported"],
    ["0.148.0", "unsupported"],
  ] satisfies readonly (readonly [CodexFixtureVersion, "supported" | "unsupported"])[])(
    "feeds Codex %s into the workspace model as %s",
    async (version, support) => {
      await using seed = await createCodexSeed({
        authenticated: true,
        projectInstructions: "root",
        projectTrust: "trusted",
        version,
      });
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
      expect(
        scan.model.instructionFiles.map((file) => [file.path, file.scope, file.links]),
      ).toEqual([
        [`${seed.homeDir}/.codex/AGENTS.md`, "global", []],
        [`${seed.workspaceDir}/AGENTS.md`, "project", []],
      ]);
      expect(scan.model.apps[0]?.metadata).toEqual({ projectTrust: "trusted" });
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
        `${seed.homeDir}/.codex/AGENTS.override.md`,
        `${seed.homeDir}/.codex/AGENTS.md`,
        `${seed.workspaceDir}/AGENTS.override.md`,
        `${seed.workspaceDir}/AGENTS.md`,
        `${seed.homeDir}/.codex/config.toml`,
      ]);
      await expect(seed.invocations("codex")).resolves.toEqual([
        ["--version"],
        ["login", "status"],
      ]);
    },
  );

  it.each([
    ["trusted", "trusted"],
    ["untrusted", "untrusted"],
    [undefined, "unknown"],
  ] as const)("surfaces a %s projects entry as trust %s", async (projectTrust, expected) => {
    await using seed = await createCodexSeed({
      authenticated: true,
      version: "0.147.0",
      ...(projectTrust === undefined ? {} : { projectTrust }),
    });
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
    expect(scan.model.apps[0]?.metadata).toEqual({ projectTrust: expected });
    // Without a seeded workspace AGENTS.md only the global instruction file appears.
    expect(scan.model.instructionFiles.map((file) => file.scope)).toEqual(["global"]);
  });

  it("reads one AGENTS.md per directory from the repository root down to the invocation directory", async () => {
    await using seed = await createCodexSeed({
      authenticated: true,
      projectInstructions: "nested",
      version: "0.147.0",
    });
    const adapter = codexPlugin.adapters?.[0];
    if (adapter === undefined) {
      throw new Error("Codex plugin did not contribute its adapter.");
    }

    const scan = await buildWorkspaceModel({
      adapters: [adapter],
      environment: createEnvironment({
        cwd: join(seed.workspaceDir, CODEX_NESTED_PACKAGE),
        environmentVariables: {},
        homeDir: seed.homeDir,
        path: seed.pathDir,
        platform: "linux",
      }),
    });

    expect(scan.diagnostics).toEqual([]);
    // The intermediate `packages` directory ships none, so it contributes nothing between them.
    expect(scan.model.instructionFiles.map((file) => file.path)).toEqual([
      `${seed.homeDir}/.codex/AGENTS.md`,
      `${seed.workspaceDir}/AGENTS.md`,
      `${seed.workspaceDir}/${CODEX_NESTED_PACKAGE}/AGENTS.md`,
    ]);
  });

  it("reports the AGENTS.override.md Codex prefers instead of the file it shadows", async () => {
    await using seed = await createCodexSeed({
      authenticated: true,
      projectInstructions: "override",
      version: "0.147.0",
    });
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
    expect(scan.model.instructionFiles.map((file) => file.path)).toEqual([
      `${seed.homeDir}/.codex/AGENTS.md`,
      `${seed.workspaceDir}/AGENTS.override.md`,
    ]);
  });

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
