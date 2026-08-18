import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runChecks } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { claudeCodeShimResponses } from "./fixtures/claude-code.js";
import { guidedCheck, officialScan } from "./official-scan.js";
import { createSeedBuilder } from "./seed.js";

/**
 * `claude mcp add` writes to `projects` in `~/.claude.json` unless told otherwise.
 *
 * The adapter models those entries at project scope against the global file's own spec, so the
 * scope an entry carries does not say which file it is in. These cases run the real parser rather
 * than a fixture, because that mapping is the thing being relied on.
 */
describe("MCP-005 against Claude Code's per-directory entries", () => {
  it("moves a team server out of the personal file into the repository file", async () => {
    await using seed = await claudeSeed("project");
    const model = await officialScan(seed, ["claude-code"]);
    const check = guidedCheck("MCP-005");
    const finding = runChecks([check], model).findings[0];

    expect(finding?.metadata).toMatchObject({
      actualScope: "project",
      appId: "claude-code",
      expectedScope: "project",
      serverName: "managed",
      sourceId: "claude-code.mcp.global",
    });
    expect(finding?.message).toContain(join(seed.homeDir, ".claude.json"));
    expect(finding?.details).toContain("personal to you");
  });

  it("does not tell someone a server in their home directory can reach source control", async () => {
    await using seed = await claudeSeed("global");
    const model = await officialScan(seed, ["claude-code"]);
    const finding = runChecks([guidedCheck("MCP-005")], model).findings[0];
    const steps = guidedCheck("MCP-005").fix(finding ?? missing(), model)?.manualSteps ?? [];

    expect(finding?.details).not.toContain("repository");
    expect(finding?.details).not.toContain("committed");
    // Both ends of this move are the same file, so there is one step, not a remove and an add.
    expect(steps.filter((step) => step.startsWith("Move MCP server managed within"))).toHaveLength(
      1,
    );
    expect(steps.some((step) => step.startsWith("Remove MCP server"))).toBe(false);
  });

  it("stays silent once the entry sits in the file its scope is written to", async () => {
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifest("project"))
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
    expect(runChecks([guidedCheck("MCP-005")], model).findings).toEqual([]);
  });
});

/** A workspace whose only `managed` entry is the per-directory one in `~/.claude.json`. */
async function claudeSeed(scope: "global" | "project") {
  return (
    createSeedBuilder()
      .homeFile("agents/aura.json", manifest(scope))
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

function manifest(scope: "global" | "project"): string {
  return (
    JSON.stringify(
      {
        apps: { "claude-code": { managed: true } },
        mcpServers: [
          {
            apps: ["claude-code"],
            name: "managed",
            scope,
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
