import { existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runCli, type CliRuntime } from "@tryaura/aura-cli";
import {
  createSeedBuilder,
  runCheck,
  type TestSeed,
  type TestSeedBuilder,
} from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

const SHARED_TEMPLATE = "# Shared agent instructions\n";

describe("aura check --fix", () => {
  it("atomically wires Claude Code, Codex, and Cursor and is idempotent", async () => {
    await using seed = await threeAppSeed().build();
    const sharedPath = join(seed.homeDir, "agents", "AGENTS.md");
    const claudePath = join(seed.homeDir, ".claude", "CLAUDE.md");
    const codexPath = join(seed.homeDir, ".codex", "AGENTS.md");
    const cursorPath = join(seed.workspaceDir, ".cursor", "rules", "aura.mdc");
    const destinations = [sharedPath, claudePath, codexPath, cursorPath];
    let changedBeforeEveryPreviewFinished = false;
    let previewCount = 0;
    const firstOutput = new CapturedOutput((chunk) => {
      if (chunk.includes("diff --aura")) {
        previewCount += 1;
        changedBeforeEveryPreviewFinished ||= destinations.some((path) => existsSync(path));
      }
    });

    const first = await run(seed, ["check", "--fix", "--yes", "--detail"], firstOutput);

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(previewCount).toBe(4);
    expect(changedBeforeEveryPreviewFinished).toBe(false);
    expect(first.stdout.indexOf("Fix preview")).toBeLessThan(
      first.stdout.indexOf("Applied 4 fix operation(s)."),
    );
    expect(first.stdout).toContain("9 passed, 0 informational, 0 warnings, 0 errors");
    await expect(readFile(sharedPath, "utf8")).resolves.toBe(SHARED_TEMPLATE);
    await expect(readFile(claudePath, "utf8")).resolves.toContain("@~/agents/AGENTS.md");
    await expect(readlink(codexPath)).resolves.toBe(sharedPath);
    await expect(readFile(cursorPath, "utf8")).resolves.toBe(
      `---\nalwaysApply: true\n---\n\n@file ${sharedPath}\n`,
    );
    // The Cursor wrapper is the only entry that has to name the source absolutely, so it is the
    // only one the user must be told not to commit.
    expect(first.stdout).toContain("Steps to take yourself:");
    expect(first.stdout).toContain(`${cursorPath} points at the shared source by absolute path`);

    const beforeSecondRun = await snapshot(seed);
    const second = await run(seed, ["check", "--fix", "--yes"]);
    const afterSecondRun = await snapshot(seed);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain("Fix preview");
    expect(second.stdout).toContain("Nothing to fix.");
    expect(second.stdout).toContain("9 passed, 0 informational, 0 warnings, 0 errors");
    expect(afterSecondRun).toEqual(beforeSecondRun);
  });

  it("shows the shape of each change without quoting file contents", async () => {
    await using seed = await threeAppSeed().build();
    const cursorPath = join(seed.workspaceDir, ".cursor", "rules", "aura.mdc");

    const result = await run(seed, ["check", "--fix", "--dry-run"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(`create ${cursorPath}`);
    expect(result.stdout).not.toContain("diff --aura");
    expect(result.stdout).toContain("Re-run with --detail to see the full diff of every change.");
    expect(result.stdout).toContain("Dry run: nothing was written.");
    expect(existsSync(cursorPath)).toBe(false);
  });

  it("refuses to write when there is nobody to ask", async () => {
    await using seed = await threeAppSeed().build();
    const sharedPath = join(seed.homeDir, "agents", "AGENTS.md");

    const result = await run(seed, ["check", "--fix"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("stdin is not a terminal");
    expect(result.stderr).toContain("--yes");
    expect(existsSync(sharedPath)).toBe(false);
  });

  it("leaves a real Codex instruction file byte-for-byte intact", async () => {
    const original = "# Personal Codex rules\n\nNever replace this file.\n";
    await using seed = await threeAppSeed().homeFile(".codex/AGENTS.md", original).build();
    const codexPath = join(seed.homeDir, ".codex", "AGENTS.md");

    const result = await run(seed, ["check", "--fix", "--yes"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Consolidate its content");
    await expect(readFile(codexPath, "utf8")).resolves.toBe(original);
    expect((await lstat(codexPath)).isSymbolicLink()).toBe(false);
  });
});

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

function threeAppSeed() {
  return createSeedBuilder()
    .shim("claude", [
      { args: ["--version"], stdout: "2.1.233 (Claude Code)\n" },
      { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
    ])
    .shim("codex", [
      { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
      { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
    ])
    .shim("cursor", [{ args: ["--version"], stdout: "3.11.0\nfixture-commit\narm64\n" }]);
}

async function run(
  seed: TestSeed,
  argv: readonly string[],
  stdout = new CapturedOutput(),
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stderr = new CapturedOutput();
  let exitCode = -1;
  const runtime: CliRuntime = {
    argv,
    cwd: seed.workspaceDir,
    environmentVariables: { PATH: seed.pathDir },
    homeDir: seed.homeDir,
    setExitCode: (value) => {
      exitCode = value;
    },
    stderr,
    stdin: Readable.from([]),
    stdout,
  };

  await runCli(AURA_DISTRO, runtime);
  return { exitCode, stderr: stderr.text, stdout: stdout.text };
}

class CapturedOutput extends Writable {
  text = "";

  constructor(private readonly observe: (chunk: string) => void = () => {}) {
    super();
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.observe(text);
    this.text += text;
    callback();
  }
}

async function snapshot(seed: TestSeed): Promise<readonly string[]> {
  return [
    ...(await snapshotTree(seed.homeDir, "home")),
    ...(await snapshotTree(seed.workspaceDir, "workspace")),
  ];
}

async function snapshotTree(root: string, label: string): Promise<readonly string[]> {
  const snapshotEntries: string[] = [];

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        snapshotEntries.push(`directory:${relativePath}`);
        await visit(path, relativePath);
      } else if (entry.isSymbolicLink()) {
        snapshotEntries.push(`symlink:${relativePath}:${await readlink(path)}`);
      } else {
        const contents = await readFile(path);
        snapshotEntries.push(`file:${relativePath}:${contents.toString("base64")}`);
      }
    }
  }

  await visit(root, label);
  return snapshotEntries;
}
