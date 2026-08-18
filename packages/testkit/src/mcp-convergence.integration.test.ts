import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { runCli } from "@tryaura/aura-cli";
import { OFFICIAL_PLUGINS, OFFICIAL_REGISTRY_OPTIONS } from "@tryaura/aura-cli/plugins";
import { describe, expect, it } from "vitest";

import { claudeCodeShimResponses } from "./fixtures/claude-code.js";
import { codexShimResponses } from "./fixtures/codex.js";
import { cursorShimResponses } from "./fixtures/cursor.js";
import { runCheck } from "./runner.js";
import { createSeedBuilder } from "./seed.js";

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
});

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

async function journalEntries(homeDir: string): Promise<readonly string[]> {
  return (await readdir(join(homeDir, "agents", ".backups"))).sort();
}

function sink(): Writable {
  return new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });
}
