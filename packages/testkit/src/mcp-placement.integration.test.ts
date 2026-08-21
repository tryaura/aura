import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { claudeCodeShimResponses } from "./fixtures/claude-code.js";
import { officialCheck, officialScan } from "./official-scan.js";
import { createSeedBuilder } from "./seed.boundary.js";

/**
 * `claude mcp add` writes to `projects` in `~/.claude.json` unless told otherwise.
 *
 * The adapter models those entries at project scope against the global file's own spec, so the
 * scope an entry carries does not say which file it is in. These cases run the real parser rather
 * than a fixture, because that mapping is the thing being relied on.
 */
describe("MCP-005 against Claude Code's per-directory entries", () => {
  it("reports a per-directory home entry as outside global configuration", async () => {
    await using seed = await claudeSeed();
    const model = await officialScan(seed, ["claude-code"]);
    const finding = runChecks([officialCheck("MCP-005")], model).findings[0];

    expect(finding?.metadata).toMatchObject({
      actualScope: "project",
      appId: "claude-code",
      serverName: "managed",
      sourceId: "claude-code.mcp.global",
    });
    expect(finding?.message).toContain(join(seed.homeDir, ".claude.json"));
    expect(finding?.details).toContain("global configuration target Aura manages");
  });

  it("does not tell someone a server in their home directory can reach source control", async () => {
    await using seed = await claudeSeed();
    const model = await officialScan(seed, ["claude-code"]);
    const finding = runChecks([officialCheck("MCP-005")], model).findings[0] ?? missing();

    expect(finding.details).not.toContain("repository");
    expect(finding.details).not.toContain("committed");
    // The remaining move is in a file Aura will not write, so the check offers no plan at all and
    // names the one that can act instead.
    expect(officialCheck("MCP-005").fixability).toBe("manual");
    expect(finding.details).toContain("MCP-001");
  });

  it("stays silent once the entry sits in the file its scope is written to", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifest())
      .homeFile(".claude.json", JSON.stringify({ mcpServers: {} }, undefined, 2) + "\n")
      .workspaceFile(
        ".mcp.json",
        JSON.stringify({ mcpServers: { managed: { command: "managed-server" } } }, undefined, 2) +
          "\n",
      )
      .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
      .build();
    const model = await officialScan(seed, ["claude-code"]);

    expect(await readFile(join(seed.workspaceDir, ".mcp.json"), "utf8")).toContain("managed");
    expect(runChecks([officialCheck("MCP-005")], model).findings[0]).toMatchObject({
      fixability: "manual",
      metadata: { actualScope: "project" },
    });
  });
});

/** A workspace whose only `managed` entry is the per-directory one in `~/.claude.json`. */
async function claudeSeed() {
  return (
    createSeedBuilder()
      .homeFile("agents/aura.json", manifest())
      // The `projects` key is the invocation directory verbatim, which the seed only knows at build.
      .homeFile(
        ".claude.json",
        (roots) =>
          JSON.stringify(
            {
              mcpServers: {},
              projects: {
                [roots.workspaceDir]: { mcpServers: { managed: { command: "managed-server" } } },
              },
            },
            undefined,
            2,
          ) + "\n",
      )
      .shim("claude", claudeCodeShimResponses({ authenticated: true, version: "2.1.233" }))
      .build()
  );
}

function manifest(): string {
  return (
    JSON.stringify(
      {
        apps: { "claude-code": { managed: true } },
        mcpServers: [
          {
            apps: ["claude-code"],
            name: "managed",
            transport: { command: "managed-server", type: "stdio" },
          },
        ],
        ownership: { "claude-code": { files: [], mcpServerNames: ["managed"] } },
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
      undefined,
      2,
    ) + "\n"
  );
}

function missing(): never {
  throw new Error("Expected an MCP-005 finding.");
}
