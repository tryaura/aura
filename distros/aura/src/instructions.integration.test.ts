import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import {
  createSeedBuilder,
  runCheck,
  type TestSeed,
  type TestSeedBuilder,
} from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

describe("Aura instruction integrity fixtures", () => {
  it("discovers legacy files without requiring their applications", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(".windsurfrules", "# Personal Windsurf rules\n")
      .workspaceFile(".clinerules", "# Project Cline rules\n")
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });
    const findings = result.findings.filter((finding) => finding.checkId === "INS-004");

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.metadata?.["tool"])).toEqual(["windsurf", "cline"]);
    expect(result.diffs).toEqual([]);
  });

  // The files stay in the inventory so every other instruction check still sees them; only the
  // legacy flag INS-004 reads is off. That the specs are still declared is covered by
  // plugins/checks-core/src/legacy-adapter.test.ts, which the JSON report cannot show here.
  it("does not report current instruction formats as legacy", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("GEMINI.md", "# Gemini rules\n")
      .homeFile("CRUSH.md", "# Crush rules\n")
      .workspaceFile("WARP.md", "# Warp rules\n")
      .workspaceFile(".github/copilot-instructions.md", "# Copilot rules\n")
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });

    expect(result.findings.filter((finding) => finding.checkId === "INS-004")).toEqual([]);
    expect(result.diffs).toEqual([]);
  });

  it("reports a seeded missing Cursor import", async () => {
    await using seed = await cursorIntegritySeed()
      .workspaceFile(".cursor/rules/missing.mdc", "Read @./gone.md.\n")
      .build();

    const failures = await instructionFailures(seed);
    expect(failures.filter((finding) => finding.metadata?.["failure"] === "missing")).toHaveLength(
      1,
    );
  });

  it.each([2, 3])("reports a seeded %s-node Cursor import cycle", async (size) => {
    let builder = cursorIntegritySeed();
    for (let index = 0; index < size; index += 1) {
      const next = (index + 1) % size;
      builder = builder.workspaceFile(
        `.cursor/rules/${String(index)}.mdc`,
        `Read @./${String(next)}.mdc.\n`,
      );
    }
    await using seed = await builder.build();

    const failures = await instructionFailures(seed);
    const cycles = failures.filter((finding) => finding.metadata?.["failure"] === "cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.locations).toHaveLength(size);
  });

  it("reports a seeded six-hop Claude Code import chain", async () => {
    let builder = cursorIntegritySeed()
      .homeFile(".claude/CLAUDE.md", ({ workspaceDir }) => `@${workspaceDir}/.cursor/rules/0.mdc\n`)
      .shim("claude", [
        { args: ["--version"], stdout: "2.1.233 (Claude Code)\n" },
        { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
      ]);
    for (let index = 0; index < 6; index += 1) {
      builder = builder.workspaceFile(
        `.cursor/rules/${String(index)}.mdc`,
        `Read @./${String(index + 1)}.mdc.\n`,
      );
    }
    builder = builder.workspaceFile(".cursor/rules/6.mdc", "End of chain.\n");
    await using seed = await builder.build();

    const failures = await instructionFailures(seed);
    expect(failures.filter((finding) => finding.metadata?.["failure"] === "depth")).toHaveLength(1);
  });

  it("reports a seeded Codex import as unsupported", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(".codex/AGENTS.md", "Read @~/agents/AGENTS.md.\n")
      .homeFile(".codex/config.toml", "")
      .homeFile("agents/AGENTS.md", "# Shared instructions\n")
      .shim("codex", [
        { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
        { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
      ])
      .build();

    const failures = await instructionFailures(seed);
    const unsupported = failures.filter(
      (finding) => finding.metadata?.["failure"] === "unsupported",
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({ severity: "warn" });
  });
});

describe("aura instruction duplication checks", () => {
  it("does not report one symlinked file as duplicating itself across applications", async () => {
    // The dotfile setup this covers: one shared file, symlinked into each application's location,
    // so both applications read the same bytes under two names.
    await using seed = await createSeedBuilder()
      .homeFile(
        ".agents/AGENTS.md",
        [
          "# Global preferences",
          "",
          "Always run the complete verification suite before merging changes because every package must remain healthy.",
          "",
          "Document surprising behavior in a comment so the next maintainer understands the constraint.",
          "",
        ].join("\n"),
      )
      .homeFile(".codex/config.toml", "")
      .shim("claude", [
        { args: ["--version"], stdout: "2.1.233 (Claude Code)\n" },
        { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
      ])
      .shim("codex", [
        { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
        { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
      ])
      .build();
    const shared = join(seed.homeDir, ".agents", "AGENTS.md");
    await mkdir(join(seed.homeDir, ".claude"), { recursive: true });
    await symlink(shared, join(seed.homeDir, ".claude", "CLAUDE.md"));
    await symlink(shared, join(seed.homeDir, ".codex", "AGENTS.md"));

    const result = await runCheck({ distro: AURA_DISTRO, seed });

    expect(result.findings.map((finding) => finding.checkId)).not.toContain("INS-003");
    expect(result.diffs).toEqual([]);
  });

  it("marks two byte-identical real files as identical, not merely similar", async () => {
    // The same dotfile setup without the symlinks: two real files with the same bytes. These are
    // still two files that can drift apart, so INS-003 must report them — but as identical, which
    // is what lets setup consolidate them without asking a question that has only one answer.
    const guidance =
      "Always run the complete verification suite before merging changes because every package must remain healthy.\n";
    await using seed = await createSeedBuilder()
      .homeFile(".claude/CLAUDE.md", guidance)
      .homeFile(".codex/AGENTS.md", guidance)
      .homeFile(".codex/config.toml", "")
      .shim("claude", [
        { args: ["--version"], stdout: "2.1.233 (Claude Code)\n" },
        { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
      ])
      .shim("codex", [
        { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
        { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
      ])
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });
    const duplicates = result.findings.filter((finding) => finding.checkId === "INS-003");

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.message).toContain("Identical guidance appears in");
    expect(duplicates[0]?.metadata?.["identical"]).toBe(true);
  });
});

describe("aura instruction precedence checks", () => {
  it("reports duplicate, contradictory, and misplaced guidance across real adapter scopes", async () => {
    const duplicate =
      "Always run the complete verification suite before merging changes because every package must remain healthy.";
    await using seed = await createSeedBuilder()
      .homeFile(
        ".claude/CLAUDE.md",
        [
          "@~/agents/AGENTS.md",
          "",
          "Always use tabs for indentation.",
          "",
          duplicate,
          "",
          "Edit packages/core/src/index.ts when changing the kernel.",
        ].join("\n"),
      )
      .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
      .workspaceFile(".git", "gitdir: /fixture/unavailable\n")
      .workspaceFile(
        "CLAUDE.md",
        ["Always use 2 spaces for indentation.", "", duplicate].join("\n"),
      )
      .shim("claude", [
        { args: ["--version"], stdout: "2.1.233 (Claude Code)\n" },
        { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
      ])
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });
    const precedence = result.findings.filter((finding) => finding.checkId === "INS-008");

    expect(precedence.map((finding) => finding.metadata?.["kind"]).sort()).toEqual([
      "contradiction",
      "duplicate",
      "project-specific",
    ]);
    // Every piece of evidence here crosses the global/project boundary, which INS-008 owns. The
    // same duplicate reported again by INS-003, or the same contradiction by INS-005, would be one
    // problem billed to the user twice at two severities.
    expect(result.findings.map((finding) => finding.checkId)).not.toContain("INS-003");
    expect(result.findings.map((finding) => finding.checkId)).not.toContain("INS-005");
    expect(JSON.stringify(precedence)).not.toContain(duplicate);
  });
});

function cursorIntegritySeed(): TestSeedBuilder {
  return createSeedBuilder().shim("cursor", [
    { args: ["--version"], stdout: "3.11.0\nfixture-commit\narm64\n" },
  ]);
}

async function instructionFailures(seed: TestSeed) {
  const result = await runCheck({ distro: AURA_DISTRO, seed });
  expect(result.diffs).toEqual([]);
  return result.findings.filter((finding) => finding.checkId === "INS-006");
}
