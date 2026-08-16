import { join } from "node:path";

import {
  defineAdapter,
  defineCheck,
  definePlugin,
  type AdapterSnapshot,
  type Environment,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { createSeedBuilder, runCheck } from "./index.js";

const AMBIENT_SECRET = "AURA_TESTKIT_AMBIENT_SECRET";

describe("seeded check integration", () => {
  it("snapshots findings without consulting the real HOME or PATH", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(".fixture/config.txt", "legacy=true\n")
      .shim("fixture-agent", [{ args: ["--version"], stdout: "fixture-agent 1.2.3\n" }])
      .build();
    let observed: Environment | undefined;
    let observedChildEnvironment: string | undefined;
    const originalExitCode = process.exitCode;
    const originalSecret = process.env[AMBIENT_SECRET];
    process.env[AMBIENT_SECRET] = "must-not-leak";

    try {
      const result = await runCheck({
        distro: {
          branding: { command: "fixture", displayName: "Fixture Doctor" },
          plugins: [
            fixturePlugin((environment, childEnvironment) => {
              observed = environment;
              observedChildEnvironment = childEnvironment;
            }),
          ],
        },
        seed,
      });

      expect({ diffs: result.diffs, exitCode: result.exitCode, findings: result.findings })
        .toMatchInlineSnapshot(`
          {
            "diffs": [],
            "exitCode": 1,
            "findings": [
              {
                "checkId": "fixture/CONFIG",
                "findingId": "legacy-config",
                "fixability": "manual",
                "locations": [
                  {
                    "line": 1,
                    "path": "<HOME>/.fixture/config.txt",
                  },
                ],
                "message": "Fixture Agent uses its legacy configuration.",
                "scope": "global",
                "severity": "warn",
              },
            ],
          }
        `);
      expect(result.report.diagnostics).toEqual([]);
      expect(result.report.status).toBe("warning");
      expect(result.report.summary).toEqual({
        categories: {
          CONFIG: { errors: 0, informational: 0, passed: 0, warnings: 1 },
        },
        diagnostics: 0,
        errors: 0,
        exitCode: 1,
        informational: 0,
        passed: 0,
        warnings: 1,
      });
      expect(result.report.apps).toEqual([
        {
          appId: "fixture-agent",
          detection: { installed: true, version: "1.2.3" },
          displayName: "Fixture Agent",
          support: { status: "supported", supportedRange: ">=1 <2", version: "1.2.3" },
        },
      ]);
      expect(result.findings).toBe(result.report.findings);
      await expect(seed.invocations("fixture-agent")).resolves.toEqual([["--version"]]);
      expect(observed?.homeDir).toBe(seed.homeDir);
      expect(observed?.cwd).toBe(seed.workspaceDir);
      expect(observed?.pathEntries).toEqual([seed.pathDir]);
      expect(observedChildEnvironment).toBe(
        `home=${seed.homeDir}\npath=${seed.pathDir}\nambient=unset\n`,
      );
      expect(process.exitCode).toBe(originalExitCode);
      expect(result.stdout).toContain("<HOME>/.fixture/config.txt");
      expect(result.stdout).not.toContain(seed.homeDir);
      expect(result.stderr).toBe("");
    } finally {
      if (originalSecret === undefined) {
        delete process.env[AMBIENT_SECRET];
      } else {
        process.env[AMBIENT_SECRET] = originalSecret;
      }
    }
  });

  it("reports what the CLI actually said when no report reaches stdout", async () => {
    await using seed = await createSeedBuilder().homeFile(".fixture/config.txt", "").build();

    const run = runCheck({
      args: ["--no-such-flag"],
      distro: {
        branding: { command: "fixture", displayName: "Fixture Doctor" },
        plugins: [fixturePlugin(() => undefined)],
      },
      seed,
    });

    // The diagnosis is on stderr and the exit code, which is precisely what a bare "expected one
    // JSON report" would throw away.
    await expect(run).rejects.toThrow("Check runner expected one JSON report on stdout.");
    await expect(run).rejects.toThrow("exit code: 2");
    await expect(run).rejects.toThrow("--no-such-flag");
  });
});

function fixturePlugin(observe: (environment: Environment, childEnvironment: string) => void) {
  const adapter = defineAdapter({
    detect: async (environment) => {
      const pathDir = environment.pathEntries[0];
      if (pathDir === undefined) {
        return { installed: false };
      }
      const executablePath = join(pathDir, "fixture-agent");
      const [version, childEnvironment] = await Promise.all([
        environment.exec({ command: executablePath, args: ["--version"] }),
        environment.exec({
          args: [
            "-c",
            `printf 'home=%s\\npath=%s\\nambient=%s\\n' "$HOME" "$PATH" "\${${AMBIENT_SECRET}:-unset}"`,
          ],
          command: "/bin/sh",
        }),
      ]);
      observe(environment, childEnvironment.stdout);
      return {
        executablePath,
        installed: version.exitCode === 0,
        version: version.stdout.trim().replace("fixture-agent ", ""),
      };
    },
    displayName: "Fixture Agent",
    files: (environment) => [
      {
        id: "config",
        kind: "config",
        path: join(environment.homeDir, ".fixture/config.txt"),
        scope: "global",
      },
    ],
    id: "fixture-agent",
    parse: ({ files }): AdapterSnapshot => {
      const config = files.get("config");
      return {
        instructionFiles: [],
        mcpServers: [],
        metadata: { legacy: config?.content?.includes("legacy=true") ?? false },
        skills: [],
      };
    },
    supportedRange: ">=1 <2",
  });
  const check = defineCheck({
    defaultSeverity: "warn",
    detect: (model) => {
      const app = model.apps.find((candidate) => candidate.adapterId === "fixture-agent");
      return app?.metadata?.["legacy"] === true
        ? [
            {
              id: "legacy-config",
              locations: [{ line: 1, path: join(model.homeDir, ".fixture/config.txt") }],
              message: "Fixture Agent uses its legacy configuration.",
            },
          ]
        : [];
    },
    explain: "The current configuration format is required.",
    fixability: "manual",
    id: "fixture/CONFIG",
    scope: "global",
    title: "Fixture Agent uses current configuration",
  });

  return definePlugin({
    adapters: [adapter],
    apiVersion: 1,
    checks: [check],
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
  });
}
