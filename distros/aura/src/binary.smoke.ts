import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { createSeedBuilder, runBinaryCheck } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import packageManifest from "../package.json" with { type: "json" };
import { BINARY_PATH, runCompiled, type BinaryRun, type SeedPaths } from "./binary-test-support.js";

const BUN_VERSION_FILE = new URL("../../../.bun-version", import.meta.url);
const execFileAsync = promisify(execFile);

/**
 * What the binary must report as its own version.
 *
 * A release stamps the tag into the manifest before compiling, and passes it back in here. Falling
 * back to the manifest is right for a local run and wrong for a release: the binary is compiled from
 * that same file, so a stamp that silently did nothing would still match itself.
 */
const EXPECTED_VERSION = process.env["AURA_EXPECTED_VERSION"] ?? packageManifest.version;

describe("compiled Aura distribution", () => {
  it("runs as Aura against an isolated testkit seed", async () => {
    await using seed = await createSeedBuilder()
      // A compiled Bun executable can load this before its entry point unless compilation disables
      // runtime dotenv loading. If it leaks in, BUN_BE_BUN turns the artifact into the Bun CLI.
      .workspaceFile(".env", "BUN_BE_BUN=1\n")
      .build();

    const version = await execFileAsync(BINARY_PATH, ["--version"], {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: { HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
    });
    expect(version).toEqual({
      stderr: "",
      stdout: `${EXPECTED_VERSION}\n`,
    });

    for (const checkId of ["ENV-001", "ENV-002", "ENV-003", "ENV-004"]) {
      const explanation = await execFileAsync(BINARY_PATH, ["check", "--explain", checkId], {
        cwd: seed.workspaceDir,
        encoding: "utf8",
        env: { HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
      });
      expect(explanation.stderr).toBe("");
      expect(explanation.stdout).toContain(`Aura check ${checkId}`);
      expect(explanation.stdout).toContain("Fixability:");

      const asJson = await execFileAsync(BINARY_PATH, ["check", "--explain", checkId, "--json"], {
        cwd: seed.workspaceDir,
        encoding: "utf8",
        env: { HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
      });
      expect(asJson.stderr).toBe("");
      expect(JSON.parse(asJson.stdout)).toMatchObject({
        fixesApplicable: checkId === "ENV-003" || checkId === "ENV-004",
        id: checkId,
      });
    }

    const result = await runBinaryCheck({ binaryPath: BINARY_PATH, seed });
    expect(result.report).toEqual({
      apps: [
        {
          appId: "claude-code",
          detection: { installed: false },
          detectionScope: "the claude CLI on PATH (the desktop app is not checked)",
          displayName: "Claude Code",
        },
        {
          appId: "codex",
          detection: { installed: false },
          detectionScope: "the codex CLI on PATH (the desktop app is not checked)",
          displayName: "Codex",
        },
        {
          appId: "cursor",
          detection: { installed: false },
          detectionScope: "the cursor shell command on PATH (the editor itself is not checked)",
          displayName: "Cursor",
        },
      ],
      diagnostics: [],
      findings: [
        {
          checkId: "INS-001",
          findingId: "shared-source",
          fixability: "auto",
          locations: [{ path: "<HOME>/agents/AGENTS.md" }],
          message: "The shared instruction source is missing.",
          scope: "global",
          severity: "error",
        },
      ],
      kind: "check-report",
      passedChecks: [
        { id: "ENV-001", title: "Agent applications use supported versions" },
        { id: "ENV-002", title: "Agent applications are authenticated" },
        {
          id: "ENV-003",
          title: "Repository ignore rules separate personal and shared agent state",
        },
        { id: "ENV-004", title: "Agent settings allow the current project to run normally" },
        { id: "INS-002", title: "Agent applications load shared instructions" },
        { id: "INS-003", title: "Instruction guidance is not duplicated" },
        { id: "INS-004", title: "Legacy instruction files are consolidated" },
        { id: "INS-005", title: "Instruction guidance does not contradict itself" },
        { id: "INS-006", title: "Instruction links are valid and supported" },
        { id: "INS-007", title: "Instruction context stays within a practical budget" },
        {
          id: "INS-008",
          title: "Instruction guidance respects global and project precedence",
        },
        {
          id: "MGD-002",
          title: "Managed skills are at their reviewed source revisions",
        },
        {
          id: "MGD-003",
          title: "Detected applications have an explicit Aura management decision",
        },
        {
          id: "MCP-001",
          title: "Managed applications have the manifest's MCP servers",
        },
        {
          id: "MCP-002",
          title: "Managed MCP servers match the manifest definition",
        },
        { id: "MCP-003", title: "Configured MCP servers can be reached" },
        { id: "MCP-005", title: "Managed MCP servers use their manifest scope" },
        { id: "SKL-001", title: "Shared skills have valid definitions and references" },
        { id: "SKL-002", title: "Managed applications deploy manifest skills" },
        { id: "SKL-003", title: "Application skill symlinks resolve" },
        { id: "SKL-004", title: "Skill invocation names are unique per application scope" },
      ],
      schemaVersion: 1,
      status: "error",
      summary: {
        categories: {
          ENV: { errors: 0, informational: 0, passed: 4, warnings: 0 },
          INS: { errors: 1, informational: 0, passed: 7, warnings: 0 },
          MCP: { errors: 0, informational: 0, passed: 4, warnings: 0 },
          MGD: { errors: 0, informational: 0, passed: 2, warnings: 0 },
          SKL: { errors: 0, informational: 0, passed: 4, warnings: 0 },
        },
        diagnostics: 0,
        errors: 1,
        exitCode: 0,
        informational: 0,
        passed: 21,
        warnings: 0,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.diffs).toEqual([]);
  });

  it("ships every environment check and uses only non-interactive status probes", async () => {
    await using seed = await createSeedBuilder()
      .workspaceFile(".git/HEAD", "ref: refs/heads/main\n")
      .workspaceFile(".claude/settings.json", '{"permissions":{"defaultMode":"plan"}}\n')
      .shim("claude", [
        { args: ["--version"], stdout: "3.0.0 (Claude Code)\n" },
        { args: ["auth", "status"], exitCode: 1, stdout: '{"loggedIn":false}\n' },
      ])
      .shim("codex", [
        { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
        { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
      ])
      .build();

    const result = await runBinaryCheck({
      args: ["--only", "ENV"],
      binaryPath: BINARY_PATH,
      seed,
    });

    expect(result.findings.map((finding) => [finding.checkId, finding.findingId])).toEqual([
      ["ENV-001", "unsupported-version:claude-code"],
      ["ENV-002", "unauthenticated:claude-code"],
      ["ENV-003", "gitignore-policy"],
      ["ENV-004", "claude-permission-mode:plan"],
      ["ENV-004", "codex-project-trust:unknown"],
    ]);
    expect(result.exitCode).toBe(0);
    await expect(seed.invocations("claude")).resolves.toEqual([["--version"], ["auth", "status"]]);
    await expect(seed.invocations("codex")).resolves.toEqual([["--version"], ["login", "status"]]);
  });

  /**
   * Two things at once, because in a compiled binary they are the same thing.
   *
   * The embedded catalog JSON is loaded, parsed, and matched against the plugin's declared
   * metadata only if the required id resolves — an asset that failed to embed drops out of the
   * catalog and reports `definition is unavailable` instead of the blocker asserted here. That the
   * blocker exists at all is the other half: `--yes` does not first-configure a credential-bearing
   * remote endpoint a repository's preset asked for, it stops and names the run that can.
   */
  it("embeds the official MCP catalog JSON and defers its first configuration to a person", async () => {
    await using seed = await createSeedBuilder()
      .workspaceFile(
        ".aura/preset.json",
        '{"schemaVersion":1,"requiredMcpServers":["official/github"]}\n',
      )
      .trustWorkspacePreset()
      .shim("codex", [
        { args: ["--version"], stdout: "codex-cli 0.147.0\n" },
        { args: ["login", "status"], stdout: "Logged in using ChatGPT\n" },
      ])
      .build();

    const result = await runSetupYes(seed);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain("definition is unavailable");
    expect(result.stdout).toContain(
      "Required MCP catalog entry official/github is not configured yet.",
    );
    await expect(
      readFile(join(seed.homeDir, ".codex", "config.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  /**
   * Records a property of the artifact rather than endorsing it.
   *
   * Compilation closes the route through a workspace `.env`, but the Bun runtime reads this variable
   * out of the ambient environment before any Aura code runs, and `bun build` offers no flag to
   * compile the behaviour out. Anyone who can set environment variables on an `aura` invocation can
   * therefore run arbitrary code through it. Pinned so that the day Bun offers a way to refuse, this
   * test fails and points at the fix instead of the property going unnoticed.
   */
  it("is still turned into the Bun CLI by an ambient BUN_BE_BUN", async () => {
    await using seed = await createSeedBuilder().build();
    const bunVersion = (await readFile(BUN_VERSION_FILE, "utf8")).trim();

    const { stdout } = await execFileAsync(BINARY_PATH, ["--version"], {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: { BUN_BE_BUN: "1", HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
    });

    expect(stdout.trim()).toBe(bunVersion);
  });
});

/** Runs `setup --yes`, keeping the output of a run that ends on a blocked plan rather than throwing. */
async function runSetupYes(seed: SeedPaths): Promise<BinaryRun> {
  return runCompiled(seed, ["setup", "--yes"], { NO_COLOR: "1" });
}
