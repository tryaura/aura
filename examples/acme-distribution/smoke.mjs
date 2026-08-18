import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { createSeedBuilder, runBinaryCheck } from "@tryaura/aura-testkit";

const seed = await createSeedBuilder()
  .homeFile(".acme-agent/AGENTS.md", "# Acme instructions\n")
  .homeFile(".acme-agent/mcp.json", '{"mcpServers":{}}\n')
  .shim("acme-agent", [{ args: ["--version"], stdout: "acme-agent 1.2.3\n" }])
  .build();

try {
  const result = await runBinaryCheck({
    binaryPath: fileURLToPath(new URL("dist/acmedev", import.meta.url)),
    seed,
  });
  const finding = result.findings.find(({ checkId }) => checkId === "acme/ACME-001");
  const app = result.report.apps.find(({ appId }) => appId === "acme-agent");

  assert.equal(
    result.exitCode,
    2,
    JSON.stringify(
      { report: result.report, stderr: result.stderr, stdout: result.stdout },
      null,
      2,
    ),
  );
  assert.equal(
    finding?.message,
    "The Acme distribution loaded its agent, snippet, skill, and MCP definition.",
  );
  assert.equal(app?.detection.version, "1.2.3");
  assert.deepEqual(result.report.diagnostics, []);
  assert.deepEqual(await seed.invocations("acme-agent"), [["--version"]]);
} finally {
  await seed.cleanup();
}
