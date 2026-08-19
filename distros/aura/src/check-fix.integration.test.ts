import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runCli, type CliRuntime } from "@tryaura/aura-cli";
import { createSeedBuilder, runCheck, type TestSeed } from "@tryaura/aura-testkit";
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
      first.stdout.indexOf("Applied 4 fix operations."),
    );
    expect(first.stdout).toContain("0 errors · 0 warnings · 3 suggestions");
    expect(first.stdout).toContain("✓ 23 checks passed · 3 applications detected");
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

    const second = await runCheck({ args: ["--fix", "--yes"], distro: AURA_DISTRO, seed });

    expect(second.exitCode).toBe(0);
    expect(second.diffs).toEqual([]);
    expect(second.stderr).toContain("No executable fixes are available");
    expect(second.report.summary).toMatchObject({ errors: 0, informational: 3, warnings: 0 });
  });

  it("shows the shape of each change without quoting file contents", async () => {
    await using seed = await threeAppSeed().build();
    const cursorPath = join(seed.workspaceDir, ".cursor", "rules", "aura.mdc");

    const result = await run(seed, ["check", "--fix", "--dry-run"]);

    expect(result.exitCode).toBe(0);
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
    expect(result.stderr).toContain("prompt output must both be terminals");
    expect(result.stderr).toContain("--yes");
    expect(existsSync(sharedPath)).toBe(false);
  });

  it("leaves a real Codex instruction file byte-for-byte intact", async () => {
    const original = "# Personal Codex rules\n\nNever replace this file.\n";
    await using seed = await threeAppSeed().homeFile(".codex/AGENTS.md", original).build();
    const codexPath = join(seed.homeDir, ".codex", "AGENTS.md");

    const result = await run(seed, ["check", "--fix", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Consolidate its content");
    await expect(readFile(codexPath, "utf8")).resolves.toBe(original);
    expect((await lstat(codexPath)).isSymbolicLink()).toBe(false);
  });

  it("does not offer a zero-operation INS-002 fix for a link with a missing target", async () => {
    await using seed = await createSeedBuilder()
      .shim("codex", [
        { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
        { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
      ])
      .build();
    const codexPath = join(seed.homeDir, ".codex", "AGENTS.md");
    const sharedPath = join(seed.homeDir, "agents", "AGENTS.md");
    await mkdir(join(seed.homeDir, ".codex"), { recursive: true });
    await symlink(sharedPath, codexPath);

    const result = await run(seed, ["check", "--only", "INS-002", "--fix", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Nothing to fix.");
    expect(result.stdout).not.toContain("No executable fixes are available");
  });
});

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
