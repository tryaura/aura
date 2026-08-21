import { mkdir, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";

import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";
import { describe, expect, it } from "vitest";

import { expectConvergedTwice } from "./convergence.js";
import { claudeCodeShimResponses } from "./fixtures/claude-code.js";
import { codexShimResponses } from "./fixtures/codex.js";
import { runCheck } from "./runner.js";
import { createSeedBuilder } from "./seed.boundary.js";

const DISTRO = {
  branding: { command: "aura", displayName: "Aura" },
  plugins: OFFICIAL_PLUGINS,
  registry: OFFICIAL_REGISTRY_OPTIONS,
};

describe("skill checks across supported adapters", () => {
  it("deploys one manifest skill to Claude Code and Codex and converges twice", async () => {
    await using seed = await baseSeed().build();
    const shared = join(seed.homeDir, "agents", "skills", "review");
    const args = ["--only", "SKL-002", "--fix", "--yes"];

    const { first } = await expectConvergedTwice(seed, () =>
      runCheck({ args, distro: DISTRO, seed }),
    );

    expect(first.report.findings).toEqual([]);
    await expect(readlink(join(seed.homeDir, ".claude", "skills", "review"))).resolves.toBe(shared);
    await expect(readlink(join(seed.homeDir, ".codex", "skills", "review"))).resolves.toBe(shared);

    // The global and project links are one skill deployed twice, not two skills fighting over a
    // name. ENV-003 keeps the project link itself out of version control.
    const after = await runCheck({ args: ["--only", "SKL-004"], distro: DISTRO, seed });
    expect(after.report.findings).toEqual([]);
  });

  it("repairs dangling Aura links for both adapters and converges twice", async () => {
    await using seed = await baseSeed().build();
    const shared = join(seed.homeDir, "agents", "skills", "review");
    const claudeLink = join(seed.homeDir, ".claude", "skills", "review");
    const codexLink = join(seed.homeDir, ".codex", "skills", "review");
    await Promise.all([
      mkdir(join(seed.homeDir, ".claude", "skills"), { recursive: true }),
      mkdir(join(seed.homeDir, ".codex", "skills"), { recursive: true }),
    ]);
    await Promise.all([
      symlink(join(seed.homeDir, "agents", "skills", "gone-claude"), claudeLink),
      symlink(join(seed.homeDir, "agents", "skills", "gone-codex"), codexLink),
    ]);

    const { first } = await expectConvergedTwice(seed, () =>
      runCheck({
        args: ["--only", "SKL-003", "--fix", "--yes"],
        distro: DISTRO,
        seed,
      }),
    );

    expect(first.report.findings).toEqual([]);
    await expect(readlink(claudeLink)).resolves.toBe(shared);
    await expect(readlink(codexLink)).resolves.toBe(shared);
  });

  it("reports invalid shared definitions and invocation collisions from both adapters", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifest())
      .homeFile(
        "agents/skills/bad/SKILL.md",
        "---\nname: résumé\ndescription: Broken name.\n---\nSee [missing](references/gone.md).\n",
      )
      .homeFile(".claude/skills/first/SKILL.md", "---\nname: duplicate\ndescription: First.\n---\n")
      .homeFile(
        ".claude/skills/second/SKILL.md",
        "---\nname: duplicate\ndescription: Second.\n---\n",
      )
      .homeFile(".codex/skills/first/SKILL.md", "---\nname: duplicate\ndescription: First.\n---\n")
      .homeFile(
        ".codex/skills/second/SKILL.md",
        "---\nname: duplicate\ndescription: Second.\n---\n",
      )
      .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
      .shim("codex", codexShimResponses({ authenticated: true, version: "0.147.0" }))
      .build();

    const result = await runCheck({
      args: ["--only", "SKL-001", "--only", "SKL-004"],
      distro: DISTRO,
      seed,
    });

    expect(result.report.findings.filter((finding) => finding.checkId === "SKL-001")).toHaveLength(
      3,
    );
    expect(
      result.report.findings
        .filter((finding) => finding.checkId === "SKL-004")
        .map((finding) => finding.metadata?.["appId"]),
    ).toEqual(["claude-code", "codex"]);
  });
});

function baseSeed() {
  return createSeedBuilder()
    .homeFile("agents/aura.json", manifest())
    .homeFile(
      "agents/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code changes.\n---\n",
    )
    .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
    .shim("codex", codexShimResponses({ authenticated: true, version: "0.147.0" }));
}

function manifest(): string {
  return (
    JSON.stringify(
      {
        apps: { "claude-code": { managed: true }, codex: { managed: true } },
        mcpServers: [],
        ownership: {},
        schemaVersion: 1,
        skills: [
          {
            id: "review",
            pinned: false,
            source: "plugin:official",
            treeHash: "a".repeat(64),
            version: "1.0.0",
          },
        ],
        snippets: [],
      },
      undefined,
      2,
    ) + "\n"
  );
}
