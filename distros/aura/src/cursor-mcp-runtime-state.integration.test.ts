import { runCheck, createSeedBuilder } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { AURA_DISTRO } from "./distro.js";

const ESC = "\u001B";
const MCP_CONFIG = `${JSON.stringify(
  { mcpServers: { docs: { args: ["-y", "@example/docs-mcp"], command: "npx" } } },
  undefined,
  2,
)}\n`;

describe("Cursor MCP runtime state", () => {
  it("explains an unapproved configured server without changing it", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(".cursor/mcp.json", MCP_CONFIG)
      .shim("cursor", [{ args: ["--version"], stdout: "3.11.0\nfixture-commit\narm64\n" }])
      .shim("cursor-agent", [
        { args: ["--version"], stdout: "2026.01.28-fd13201\n" },
        {
          args: ["mcp", "list"],
          stdout: `${ESC}[2K${ESC}[Gdocs: not loaded (needs approval)\n`,
        },
      ])
      .shim("npx", [{ args: [] }])
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });
    const finding = result.findings.find(
      (candidate) =>
        candidate.checkId === "MCP-003" && candidate.metadata?.["serverName"] === "docs",
    );

    expect(finding).toMatchObject({
      message: "MCP server docs in Cursor needs approval.",
      metadata: {
        appId: "cursor",
        kind: "cursor-state",
        serverName: "docs",
        state: "needs-approval",
      },
      severity: "warn",
    });
    expect(result.stdout).toContain("Open Cursor, open MCP settings, and approve server docs.");
    await expect(seed.invocations("cursor")).resolves.toEqual([["--version"]]);
    await expect(seed.invocations("cursor-agent")).resolves.toEqual([
      ["--version"],
      ["mcp", "list"],
    ]);
    // Aura starts no MCP server itself. This does not show that nothing starts one: `cursor-agent`
    // is shimmed here, and the real command connects to the servers it is given. That it is handed
    // only the user's own global configuration is what the adapter's `cwd` test pins down.
    await expect(seed.invocations("npx")).resolves.toEqual([]);
  });

  it("says the states are missing rather than reporting the server as fine", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(".cursor/mcp.json", MCP_CONFIG)
      .shim("cursor", [{ args: ["--version"], stdout: "3.11.0\n" }])
      .shim("cursor-agent", [
        { args: ["--version"], stdout: "2026.01.28\n" },
        { args: ["mcp", "list"], exitCode: 2, stderr: "cursor-agent: not signed in\n" },
      ])
      .shim("npx", [{ args: [] }])
      .build();

    const result = await runCheck({ distro: AURA_DISTRO, seed });
    const finding = result.findings.find(
      (candidate) => candidate.metadata?.["kind"] === "cursor-state-unavailable",
    );

    expect(finding).toMatchObject({
      metadata: { appId: "cursor", reason: "failed" },
      severity: "info",
    });
    // The failure is Cursor's, not the workspace's, so nothing it produces may fail the run.
    expect(
      result.findings.filter(
        (candidate) => candidate.checkId === "MCP-003" && candidate.severity === "error",
      ),
    ).toEqual([]);
  });
});
