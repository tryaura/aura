import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runCli, type CliRuntime } from "@tryaura/aura-cli";
import { claudeCodePlugin } from "@tryaura/aura-cli/plugins";
import {
  applyFixPlan,
  buildWorkspaceModel,
  createEnvironment,
  planManifestMcpConvergence,
  planMcpSecretRemediation,
  prepareFixPlan,
} from "@tryaura/core";
import type { FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";
import { createSeedBuilder, runCheck, type TestSeed } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

const SENTINEL = "sk-aura-permanent-integration-sentinel-7Qx9Lm2Np4Rs6Tv8";
const NOW = () => new Date("2026-08-18T00:00:00.000Z");

describe("MCP secret permanent sentinel audit", () => {
  it("keeps the sentinel out of every report and permits it only in the protected undo payload", async () => {
    await using seed = await secretSeed().build();
    const configPath = join(seed.homeDir, ".claude.json");

    const human = await run(seed, ["check"]);
    const detail = await run(seed, ["check", "--detail"]);
    const redirected = await run(seed, ["check", "--fix"]);
    const json = await runCheck({ distro: AURA_DISTRO, seed });
    for (const output of [
      human.stdout,
      human.stderr,
      detail.stdout,
      detail.stderr,
      redirected.stdout,
      redirected.stderr,
      json.stdout,
      json.stderr,
    ]) {
      expect(output).not.toContain(SENTINEL);
    }
    // No registered check offers to rewrite the credential while MCP-004 is withdrawn, but the
    // scan still reads the file holding it, and every other fix must leave that source untouched.
    await expect(readFile(configPath, "utf8")).resolves.toContain(SENTINEL);
    expect(JSON.stringify(json.report)).not.toContain(SENTINEL);

    const model = await scan(seed);
    const plan = sentinelPlan(model);
    const prepared = await prepareFixPlan({ model, plan });
    const serializedPreview = JSON.stringify(prepared.preview);
    expect(serializedPreview).not.toContain(SENTINEL);
    expect(serializedPreview).toContain("[redacted]");
    expect(prepared.preview.manualSteps.slice(-1)).toEqual(["Run `aura check` again."]);
    expect(
      prepared.preview.manualSteps.findIndex((step) => step.includes("export")),
    ).toBeGreaterThan(
      prepared.preview.manualSteps.findLastIndex((step) => step.startsWith("Copy")),
    );

    const dryRun = await prepareFixPlan({ model, plan });
    expect(JSON.stringify(dryRun.preview)).not.toContain(SENTINEL);
    const applied = await applyFixPlan(prepared, { now: NOW, stateHomeDir: seed.homeDir });
    expect(JSON.stringify(applied)).not.toContain(SENTINEL);

    const rewritten = await readFile(configPath, "utf8");
    expect(rewritten).not.toContain(SENTINEL);
    expect(rewritten).toContain("${API_TOKEN}");
    expect(rewritten).toContain("${DOCS_ARGS_1}");
    expect((await scan(seed)).mcpSecretSightings).toEqual([]);

    const journalRoot = join(seed.homeDir, "agents", ".backups");
    const journalFiles = await recursiveFiles(journalRoot);
    const retaining = [];
    for (const path of journalFiles) {
      const content = await readFile(path);
      if (content.includes(Buffer.from(SENTINEL))) {
        retaining.push(path);
      }
    }
    expect(retaining).toHaveLength(1);
    expect(retaining[0]).toMatch(/files\/0-before\.bin$/u);
    expect((await lstat(retaining[0] ?? "")).mode & 0o777).toBe(0o600);
    const manifests = journalFiles.filter((path) => path.endsWith("manifest.json"));
    expect(manifests).toHaveLength(1);
    expect(await readFile(manifests[0] ?? "", "utf8")).not.toContain(SENTINEL);
  });

  it("redacts a coalesced convergence and secret-remediation write on both diff sides", async () => {
    await using seed = await managedSecretSeed().build();
    const model = await scan(seed);
    const sighting = model.mcpSecretSightings[0];
    if (sighting === undefined) {
      throw new Error("Expected the permanent MCP sentinel sighting.");
    }
    const secretPlan = planMcpSecretRemediation(model, sighting);
    const convergence = planManifestMcpConvergence(model, "claude-code").plan;
    if (secretPlan === undefined || convergence === undefined) {
      throw new Error("Expected both MCP remediation plans.");
    }
    const combined: FixPlan = {
      operations: [...convergence.operations, ...secretPlan.operations],
      summary: "Combine MCP drift and secret remediation.",
    };

    const prepared = await prepareFixPlan({ model, plan: combined });
    expect(prepared.preview.operations).toHaveLength(1);
    expect(JSON.stringify(prepared.preview)).not.toContain(SENTINEL);
    expect(prepared.preview.operations[0]?.diff).toContain("[redacted]");
  });
});

function secretSeed() {
  return createSeedBuilder()
    .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
    .homeFile(".claude/CLAUDE.md", "@~/agents/AGENTS.md\n")
    .homeFile(
      ".claude.json",
      `${JSON.stringify(
        {
          mcpServers: {
            docs: {
              args: ["--api-key", SENTINEL],
              command: "npx",
              env: { API_TOKEN: SENTINEL },
            },
          },
        },
        undefined,
        2,
      )}\n`,
    )
    .shim("claude", claudeResponses())
    .shim("npx", [{ args: [] }]);
}

function managedSecretSeed() {
  return createSeedBuilder()
    .homeFile("agents/AGENTS.md", "# Shared agent instructions\n")
    .homeFile(".claude/CLAUDE.md", "@~/agents/AGENTS.md\n")
    .homeFile("agents/aura.json", `${JSON.stringify(manifest())}\n`)
    .homeFile(
      ".claude.json",
      `${JSON.stringify(
        {
          mcpServers: {
            managed: { command: "old-command" },
            personal: { command: "npx", env: { API_TOKEN: SENTINEL } },
          },
        },
        undefined,
        2,
      )}\n`,
    )
    .shim("claude", claudeResponses())
    .shim("new-command", [{ args: [] }])
    .shim("npx", [{ args: [] }]);
}

function manifest() {
  return {
    apps: { "claude-code": { managed: true } },
    mcpServers: [
      {
        apps: ["claude-code"],
        name: "managed",
        transport: { command: "new-command", type: "stdio" },
      },
    ],
    ownership: { "claude-code": { files: [], mcpServerNames: ["managed"] } },
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}

function claudeResponses() {
  return [
    { args: ["--version"], stdout: "2.1.233 (Claude Code)\n" },
    { args: ["auth", "status"], stdout: '{"loggedIn":true}\n' },
  ];
}

async function scan(seed: TestSeed): Promise<WorkspaceModel> {
  const adapter = claudeCodePlugin.adapters?.[0];
  if (adapter === undefined) {
    throw new Error("Claude Code adapter is missing.");
  }
  const built = await buildWorkspaceModel({
    adapters: [adapter],
    environment: createEnvironment({
      cwd: seed.workspaceDir,
      environmentVariables: {},
      homeDir: seed.homeDir,
      path: seed.pathDir,
      platform: "linux",
    }),
  });
  return built.model;
}

/**
 * Plans the sentinel's remediation from core rather than through the check that used to own it.
 *
 * The audit protects the redaction, backup, and undo path around a credential rewrite, and that
 * path belongs to core. Reaching it through MCP-004's registration entry tied the guarantee to
 * whether the check happens to be registered, which is exactly the thing that changed.
 */
function sentinelPlan(model: WorkspaceModel): FixPlan {
  const sighting = model.mcpSecretSightings[0];
  if (sighting === undefined) {
    throw new Error("Expected the permanent MCP sentinel sighting.");
  }
  const plan = planMcpSecretRemediation(model, sighting);
  if (plan === undefined) {
    throw new Error("MCP secret remediation did not produce its whole-file plan.");
  }
  return plan;
}

async function recursiveFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function run(
  seed: TestSeed,
  argv: readonly string[],
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const stderr = new Capture();
  const stdout = new Capture();
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

class Capture extends Writable {
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
