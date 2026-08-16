import { defineCheck, definePlugin } from "@tryaura/aura-sdk";
import type { CliDistro } from "@tryaura/aura-cli";
import { describe, expect, it } from "vitest";

import { createSeedBuilder, runSetup } from "./index.js";

describe("seeded setup integration", () => {
  it("creates the baseline on the first run and converges on the second", async () => {
    await using seed = await createSeedBuilder().build();

    const first = await runSetup({ distro: distro(), seed });

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Applied 2 operation(s).");
    expect(first.stdout).toContain("1 passed, 0 informational, 0 warnings, 0 errors");
    const paths = first.diffs.map((diff) => `${diff.status}:${diff.path}`);
    expect(paths).toContain("added:<HOME>/agents/aura.json");
    expect(paths).toContain("added:<HOME>/agents/AGENTS.md");
    const manifestDiff = first.diffs.find((diff) => diff.path === "<HOME>/agents/aura.json");
    expect(manifestDiff?.patch).toContain("600");

    const second = await runSetup({ distro: distro(), seed });

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Already converged — nothing to change.");
    expect(second.diffs.filter((diff) => !diff.path.includes(".backups"))).toEqual([]);
  });

  it("stops at the plan under --dry-run and changes nothing", async () => {
    await using seed = await createSeedBuilder().build();

    const result = await runSetup({ args: ["--dry-run"], distro: distro(), seed });

    // `--yes` and `--dry-run` contradict each other, which is exactly what this boundary should
    // surface rather than silently picking one.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--dry-run and --yes contradict each other");
    expect(result.diffs).toEqual([]);
  });
});

function distro(): CliDistro {
  return {
    branding: { command: "fixture", displayName: "Fixture Doctor" },
    plugins: [
      definePlugin({
        apiVersion: 1,
        checks: [
          defineCheck({
            defaultSeverity: "info",
            detect: () => [],
            explain: "Test check.",
            fixability: "manual",
            id: "fixture/PASS",
            scope: "global",
            title: "Passing check",
          }),
        ],
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
      }),
    ],
  };
}
