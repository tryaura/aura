import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runCli } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";
import { executeFixPlan, planManifestMcpConvergence, runChecks, undoFixPlan } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { claudeCodeShimResponses } from "./fixtures/claude-code.js";
import { codexShimResponses } from "./fixtures/codex.js";
import { cursorShimResponses } from "./fixtures/cursor.js";
import { guidedCheck, officialScan, type ScannableSeed } from "./official-scan.js";
import { runCheck } from "./runner.js";
import { createSeedBuilder } from "./seed.boundary.js";

const DISTRO = {
  branding: { command: "aura", displayName: "Aura" },
  plugins: OFFICIAL_PLUGINS,
  registry: OFFICIAL_REGISTRY_OPTIONS,
};

describe("manifest-driven MCP convergence", () => {
  it("converges all official adapters atomically and does no work on the second run", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifest())
      .homeFile(
        ".claude.json",
        JSON.stringify({ mcpServers: { personal: { command: "keep-claude" } } }, undefined, 2) +
          "\n",
      )
      .homeFile(
        ".cursor/mcp.json",
        JSON.stringify({ mcpServers: { personal: { command: "keep-cursor" } } }, undefined, 2) +
          "\n",
      )
      .homeFile(".codex/config.toml", '[mcp_servers.personal]\ncommand = "keep-codex"\n')
      .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
      .shim("codex", codexShimResponses({ authenticated: true, version: "0.147.0" }))
      .shim("cursor", cursorShimResponses({ version: "3.11.0" }))
      .build();
    const args = ["--only", "MCP-001", "--only", "MCP-002", "--fix", "--yes"];

    const first = await runCheck({ args, distro: DISTRO, seed });
    expect(first.exitCode).toBe(0);
    expect(first.report.findings).toEqual([]);
    expect(first.diffs.filter((diff) => !diff.path.includes("/.backups"))).toHaveLength(4);

    const [claude, cursor, codex, desired] = await Promise.all([
      readFile(join(seed.homeDir, ".claude.json"), "utf8"),
      readFile(join(seed.homeDir, ".cursor", "mcp.json"), "utf8"),
      readFile(join(seed.homeDir, ".codex", "config.toml"), "utf8"),
      readFile(join(seed.homeDir, "agents", "aura.json"), "utf8"),
    ]);
    expect(claude).toContain("keep-claude");
    expect(cursor).toContain("keep-cursor");
    expect(codex).toContain("keep-codex");
    expect(claude).toContain('"managed"');
    expect(cursor).toContain('"managed"');
    expect(codex).toContain("[mcp_servers.managed]");
    expect(JSON.parse(desired)).toMatchObject({
      ownership: {
        "claude-code": { mcpServerNames: ["managed"] },
        codex: { mcpServerNames: ["managed"] },
        cursor: { mcpServerNames: ["managed"] },
      },
    });

    const journalAfterFirst = await journalEntries(seed.homeDir);
    const second = await runCheck({ args, distro: DISTRO, seed });
    expect(second.exitCode).toBe(0);
    expect(second.report.findings).toEqual([]);
    expect(second.diffs.filter((diff) => !diff.path.includes("/.backups"))).toEqual([]);
    expect(await journalEntries(seed.homeDir)).toEqual(journalAfterFirst);

    const undoExitCode = await runCli(DISTRO, {
      argv: ["undo", "--yes"],
      colorDepth: 0,
      cwd: seed.workspaceDir,
      environmentVariables: { PATH: seed.pathDir },
      homeDir: seed.homeDir,
      setExitCode: () => undefined,
      stderr: sink(),
      stdin: Readable.from([]),
      stdout: sink(),
    });
    expect(undoExitCode).toBe(0);
    const [restoredClaude, restoredCursor, restoredCodex, restoredManifest] = await Promise.all([
      readFile(join(seed.homeDir, ".claude.json"), "utf8"),
      readFile(join(seed.homeDir, ".cursor", "mcp.json"), "utf8"),
      readFile(join(seed.homeDir, ".codex", "config.toml"), "utf8"),
      readFile(join(seed.homeDir, "agents", "aura.json"), "utf8"),
    ]);
    expect(restoredClaude).not.toContain('"managed"');
    expect(restoredCursor).not.toContain('"managed"');
    expect(restoredCodex).not.toContain("# aura:begin MCP");
    expect(JSON.parse(restoredManifest)).toMatchObject({
      ownership: {
        "claude-code": { mcpServerNames: [] },
        codex: { mcpServerNames: [] },
        cursor: { mcpServerNames: [] },
      },
    });
  });

  it("moves an owned server across scopes idempotently and undoes both files and ledger", async () => {
    const globalBefore =
      JSON.stringify({ mcpServers: { personal: { command: "keep-cursor" } } }, undefined, 2) + "\n";
    const projectBefore =
      JSON.stringify({ mcpServers: { managed: { command: "managed-server" } } }, undefined, 2) +
      "\n";
    const manifestBefore = misplacedManifest();
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifestBefore)
      .homeFile(".cursor/mcp.json", globalBefore)
      .workspaceFile(".cursor/mcp.json", projectBefore)
      .shim("cursor", cursorShimResponses({ version: "3.11.0" }))
      .build();
    const firstScan = await cursorScan(seed);
    const check = guidedCheck("MCP-005");
    const finding = runChecks([check], firstScan).findings[0];
    if (finding === undefined) {
      throw new Error("Expected a guided MCP-005 finding.");
    }
    const plan = check.fix(finding, firstScan);
    if (plan === undefined) {
      throw new Error("Expected MCP-005 to build a move plan.");
    }

    const applied = await executeFixPlan({
      model: firstScan,
      now: () => new Date("2026-08-18T01:02:03.004Z"),
      plan,
    });
    expect(applied.appliedOperationCount).toBe(3);
    expect(await readFile(join(seed.homeDir, ".cursor", "mcp.json"), "utf8")).toContain(
      '"managed"',
    );
    expect(await readFile(join(seed.workspaceDir, ".cursor", "mcp.json"), "utf8")).not.toContain(
      '"managed"',
    );
    expect(
      JSON.parse(await readFile(join(seed.homeDir, "agents", "aura.json"), "utf8")),
    ).toMatchObject({ ownership: { cursor: { mcpServerNames: ["managed"] } } });

    const converged = await cursorScan(seed);
    expect(runChecks([check], converged).findings).toEqual([]);
    const secondPlan = planManifestMcpConvergence(converged, "cursor").plan;
    if (secondPlan === undefined) {
      throw new Error("Expected a converged Cursor plan.");
    }
    const second = await executeFixPlan({
      model: converged,
      now: () => new Date("2026-08-18T01:02:04.004Z"),
      plan: secondPlan,
    });
    expect(second.appliedOperationCount).toBe(0);

    if (applied.backupId === undefined) {
      throw new Error("Expected the scope move to create an undo backup.");
    }
    await expect(
      undoFixPlan({
        backupId: applied.backupId,
        model: converged,
        now: () => new Date("2026-08-18T01:02:05.004Z"),
      }),
    ).resolves.toMatchObject({ restoredOperationCount: 3, status: "undone" });
    await expect(readFile(join(seed.homeDir, ".cursor", "mcp.json"), "utf8")).resolves.toBe(
      globalBefore,
    );
    await expect(readFile(join(seed.workspaceDir, ".cursor", "mcp.json"), "utf8")).resolves.toBe(
      projectBefore,
    );
    await expect(readFile(join(seed.homeDir, "agents", "aura.json"), "utf8")).resolves.toBe(
      manifestBefore,
    );
  });
});

async function cursorScan(seed: ScannableSeed) {
  return officialScan(seed, ["cursor"]);
}

function manifest(): string {
  return (
    JSON.stringify(
      {
        apps: {
          "claude-code": { managed: true },
          codex: { managed: true },
          cursor: { managed: true },
        },
        mcpServers: [
          {
            apps: ["claude-code", "codex", "cursor"],
            name: "managed",
            scope: "global",
            transport: {
              args: ["-y", "@example/managed"],
              command: "npx",
              env: ["TOKEN"],
              type: "stdio",
            },
          },
        ],
        ownership: {
          "claude-code": { files: [], mcpServerNames: [] },
          codex: { files: [], mcpServerNames: [] },
          cursor: { files: [], mcpServerNames: [] },
        },
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
      undefined,
      2,
    ) + "\n"
  );
}

function misplacedManifest(): string {
  return (
    JSON.stringify(
      {
        apps: { cursor: { managed: true } },
        mcpServers: [
          {
            apps: ["cursor"],
            name: "managed",
            scope: "global",
            transport: { command: "managed-server", type: "stdio" },
          },
        ],
        ownership: { cursor: { files: [], mcpServerNames: ["managed", "stale"] } },
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
      undefined,
      2,
    ) + "\n"
  );
}

async function journalEntries(homeDir: string): Promise<readonly string[]> {
  return (await readdir(join(homeDir, "agents", ".backups"))).sort();
}

function sink(): Writable {
  return new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });
}
