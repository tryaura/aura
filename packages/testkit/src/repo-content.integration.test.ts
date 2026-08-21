import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { defineCheck, definePlugin } from "@tryaura/aura-sdk";
import type { CliDistro } from "@tryaura/aura-cli";
import { describe, expect, it } from "vitest";

import { createSeedBuilder, expectConvergedTwice, runSetup } from "./index.js";
import type { TestSeedBuilder } from "./types.js";

const SNIPPET_BODY = "# Conventions\n\n- Keep changes deterministic.\n";
const SNIPPET_FILE = `---\nname: Conventions\ndescription: House rules.\n---\n${SNIPPET_BODY}`;
const SKILL_FILE =
  "---\nname: Release runbook\ndescription: Cut a release.\nversion: 1.0.0\n---\nSteps.\n";

function repoSeed(): TestSeedBuilder {
  return createSeedBuilder()
    .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
    .workspaceFile(
      ".aura/preset.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [{ id: "release-runbook", source: "repo:workspace" }],
        snippets: ["repo/conventions"],
      }),
    )
    .workspaceFile(".aura/snippets/conventions.md", SNIPPET_FILE)
    .workspaceFile(".aura/skills/release-runbook/SKILL.md", SKILL_FILE);
}

describe("repository content integration", () => {
  it("holds first installs of trusted repository content under --yes", async () => {
    await using seed = await repoSeed().trustWorkspacePreset().build();

    const { first, second } = await expectConvergedTwice(seed, () =>
      runSetup({ distro: distro(), seed }),
    );

    expect(first.exitCode).toBe(0);
    const instructions = await readFile(join(seed.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(instructions).not.toContain(SNIPPET_BODY.trimEnd());
    expect(instructions).not.toContain("House rules.");
    const manifest: unknown = JSON.parse(
      await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ skills: [], snippets: [] });
    await expect(stat(join(seed.homeDir, "agents", "skills", "release-runbook"))).rejects.toThrow();
    expect(second.stdout).toContain("Already converged — nothing to do.");
  });

  it("contributes nothing when the repository is untrusted", async () => {
    await using seed = await repoSeed().build();

    const result = await runSetup({ distro: distro(), seed });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Repository preset held (not trusted on this machine)");
    const instructions = await readFile(join(seed.homeDir, "agents", "AGENTS.md"), "utf8");
    expect(instructions).not.toContain("Conventions");
    const manifest: unknown = JSON.parse(
      await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ skills: [], snippets: [] });
  });

  it("fails closed when the hash-covered snippet set is broken", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
      .workspaceFile(".aura/preset.json", JSON.stringify({ schemaVersion: 1 }))
      .workspaceFile(".aura/snippets/Bad Name.md", "Body.\n")
      .build();

    const result = await runSetup({ distro: distro(), seed });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Repository snippets directory");
    expect(result.stderr).not.toContain("Bad Name");
    expect(result.diffs).toEqual([]);
  });
});

function distro(): CliDistro {
  return {
    branding: { command: "fixture", displayName: "Fixture Doctor" },
    plugins: [
      definePlugin({
        apiVersion: 2,
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
