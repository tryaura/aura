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
      .workspaceFile("GEMINI.md", "# Project Gemini rules\n")
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });
    const findings = result.findings.filter((finding) => finding.checkId === "INS-004");

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.metadata?.["tool"])).toEqual(["windsurf", "gemini"]);
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
