import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runCli, type CliRuntime } from "@tryaura/aura-cli";
import {
  claudeCodeShimResponses,
  codexShimResponses,
  createClaudeCodeSeed,
  createSeedBuilder,
  cursorShimResponses,
  type TestSeed,
} from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

describe("aura setup", () => {
  it("first run and fifth run are the same flow, and only the first one writes", async () => {
    await using seed = await createSeedBuilder().build();
    const manifestPath = join(seed.homeDir, "agents", "aura.json");
    const sharedPath = join(seed.homeDir, "agents", "AGENTS.md");

    const first = await run(seed, ["setup", "--yes"]);

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("Applied 2 operation(s).");
    expect(first.stdout).toContain("0 warnings, 0 errors");
    await expect(readFile(manifestPath, "utf8")).resolves.toContain('"schemaVersion": 1');
    await expect(readFile(sharedPath, "utf8")).resolves.toBe("# Shared agent instructions\n");

    const afterFirst = await snapshot(seed);
    for (let iteration = 2; iteration <= 5; iteration += 1) {
      const repeat = await run(seed, ["setup", "--yes"]);
      expect(repeat.exitCode).toBe(0);
      expect(repeat.stdout).toContain("Already converged — nothing to change.");
    }
    await expect(snapshot(seed)).resolves.toEqual(afterFirst);
  });

  it("refuses to run the wizard when there is nobody to answer it", async () => {
    await using seed = await createSeedBuilder().build();

    const result = await run(seed, ["setup"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("stdin and stdout must both be terminals");
    expect(result.stderr).toContain("--yes");
    expect(existsSync(join(seed.homeDir, "agents"))).toBe(false);
  });

  it("stores target locks outside an overridden managed home", async () => {
    await using seed = await createSeedBuilder().build();
    const managedHome = join(seed.workspaceDir, "managed-home");
    await mkdir(managedHome, { recursive: true });

    const result = await run(seed, ["setup", "--yes", "--home", managedHome]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(seed.homeDir, "agents", ".backups", ".target-locks"))).toBe(true);
    expect(existsSync(join(managedHome, "agents", ".backups", ".target-locks"))).toBe(false);
  });

  it("offers the whole registry as not found on a machine with no apps", async () => {
    await using seed = await createSeedBuilder().build();

    const result = await run(seed, ["setup", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "✗ Claude Code — looked for the claude CLI on PATH (the desktop app is not checked)",
    );
    expect(result.stdout).toContain(
      "✗ Codex — looked for the codex CLI on PATH (the desktop app is not checked)",
    );
    expect(result.stdout).toContain(
      "✗ Cursor — looked for the cursor shell command on PATH (the editor itself is not checked)",
    );
    expect(result.stdout).toContain("No agent applications were detected.");
    const manifest = await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ apps: {} });
  });

  it("pre-selects a detected application and stores it in the manifest", async () => {
    await using seed = await createClaudeCodeSeed({ authenticated: true, version: "2.1.233" });

    const result = await run(seed, ["setup", "--yes"]);

    expect(result.stdout).toContain("✓ Claude Code 2.1.233 (authenticated)");
    expect(result.stdout).toContain(
      "✗ Codex — looked for the codex CLI on PATH (the desktop app is not checked)",
    );
    expect(result.stdout).not.toContain("Steps to take yourself:");
    const manifest = await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ apps: { "claude-code": { managed: true } } });
  });

  it("detects three applications on one machine and manages them all", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
      .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
      .shim("codex", codexShimResponses({ authenticated: true, version: "0.147.0" }))
      .shim("cursor", cursorShimResponses({ version: "3.11.0" }))
      .build();

    const result = await run(seed, ["setup", "--yes"]);

    expect(result.stdout).toContain("✓ Claude Code 2.1.233 (authenticated)");
    expect(result.stdout).toContain("✓ Codex 0.147.0 (authenticated)");
    expect(result.stdout).toContain("✓ Cursor 3.11.0");
    const manifest = await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({
      apps: {
        "claude-code": { managed: true },
        codex: { managed: true },
        cursor: { managed: true },
      },
    });
  });

  it("flags an unsupported version but keeps the application manageable", async () => {
    await using seed = await createClaudeCodeSeed({ authenticated: true, version: "3.0.0" });

    const result = await run(seed, ["setup", "--yes"]);

    expect(result.stdout).toContain(
      "⚠ Claude Code 3.0.0 — unsupported version (supported: >=2.1.0 <3.0.0); fixes are downgraded",
    );
    const manifest = await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ apps: { "claude-code": { managed: true } } });
  });

  it("keeps managing a selected application that is not installed and shows its install hint", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(
        "agents/aura.json",
        JSON.stringify(
          {
            apps: { codex: { managed: true } },
            mcpServers: [],
            ownership: {},
            schemaVersion: 1,
            skills: [],
            snippets: [],
          },
          undefined,
          2,
        ) + "\n",
      )
      .build();

    const result = await run(seed, ["setup", "--yes"]);

    expect(result.stdout).toContain("Steps to take yourself:");
    expect(result.stdout).toContain("Install Codex: Run `npm install -g @openai/codex@latest`");
    const manifest = await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8");
    expect(JSON.parse(manifest)).toMatchObject({ apps: { codex: { managed: true } } });
  });

  it("stops at the plan under --dry-run without writing", async () => {
    await using seed = await createSeedBuilder().build();
    const before = await snapshot(seed);

    const result = await run(seed, ["setup", "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`create ${join(seed.homeDir, "agents", "aura.json")}`);
    expect(result.stdout).toContain("Dry run: nothing was written.");
    await expect(snapshot(seed)).resolves.toEqual(before);
  });
});

async function run(
  seed: TestSeed,
  argv: readonly string[],
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stdout = new CapturedOutput();
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

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
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
        snapshotEntries.push(`file:${relativePath}:${await readFile(path, "utf8")}`);
      }
    }
  }

  await visit(root, label);
  return snapshotEntries;
}
