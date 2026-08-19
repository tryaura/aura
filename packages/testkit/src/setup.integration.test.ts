import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { hashManagedSnippet } from "@tryaura/core";
import { defineCheck, definePlugin } from "@tryaura/aura-sdk";
import type { CliDistro } from "@tryaura/aura-cli";
import { describe, expect, it } from "vitest";

import { createSeedBuilder, expectConvergedTwice, runSetup } from "./index.js";

describe("seeded setup integration", () => {
  it("creates the baseline on the first run and converges on the second", async () => {
    await using seed = await createSeedBuilder().build();

    const { first, second } = await expectConvergedTwice(seed, () =>
      runSetup({ distro: distro(), seed }),
    );

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Applied 2 operations.");
    expect(first.stdout).toContain("0 errors · 0 warnings · 0 suggestions");
    expect(first.stdout).toContain("✓ 1 check passed");
    const paths = first.diffs.map((diff) => `${diff.status}:${diff.path}`);
    expect(paths).toContain("added:<HOME>/agents/aura.json");
    expect(paths).toContain("added:<HOME>/agents/AGENTS.md");
    const manifestDiff = first.diffs.find((diff) => diff.path === "<HOME>/agents/aura.json");
    expect(manifestDiff?.patch).toContain("600");

    expect(second.stdout).toContain("Already converged — nothing to do.");
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

  it("installs a third-party snippet through the standard contribution path", async () => {
    const snippetContent = "# Fixture rules\n\n- Keep fixture behavior deterministic.\n";
    const snippetId = "fixture-content/rules";
    const snippetHash = hashManagedSnippet(snippetContent);
    await using seed = await createSeedBuilder()
      .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
      .homeFile(
        "agents/aura.json",
        JSON.stringify(
          {
            apps: {},
            mcpServers: [],
            ownership: {},
            schemaVersion: 1,
            skills: [],
            snippets: [{ hash: snippetHash, id: snippetId, pinned: false, version: "1.0.0" }],
          },
          undefined,
          2,
        ) + "\n",
      )
      .workspaceFile("fixture-snippet.md", snippetContent)
      .build();

    const { first: result } = await expectConvergedTwice(seed, () =>
      runSetup({ distro: snippetDistro(seed.workspaceDir), seed }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const instructions = await readFile(join(seed.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(instructions).toContain(`<!-- aura:begin id=${snippetId} sha256=${snippetHash} -->`);
    expect(instructions).toContain(snippetContent);
    const manifest: unknown = JSON.parse(
      await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      snippets: [{ hash: snippetHash, id: snippetId, pinned: false, version: "1.0.0" }],
    });
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

function snippetDistro(workspaceDir: string): CliDistro {
  const base = distro();
  return {
    ...base,
    plugins: [
      ...base.plugins,
      definePlugin({
        apiVersion: 1,
        id: "fixture-content",
        name: "Fixture content",
        snippets: [
          {
            category: "fixture",
            description: "Provides deterministic fixture rules.",
            id: "fixture-content/rules",
            kind: "snippet",
            name: "Fixture rules",
            source: {
              type: "file",
              url: pathToFileURL(join(workspaceDir, "fixture-snippet.md")).href,
            },
            version: "1.0.0",
          },
        ],
        version: "1.0.0",
      }),
    ],
  };
}
