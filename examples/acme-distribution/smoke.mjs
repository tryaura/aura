import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSeedBuilder, runBinaryCheck } from "@tryaura/aura-testkit";

const BINARY_PATH = fileURLToPath(new URL("dist/acmedev", import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * The desired state a previous interactive run would have left behind.
 *
 * The platform preset requires the `acme/source-control` catalog entry, and a non-interactive run
 * never first-configures one of those on a repository's say-so — it re-applies what the manifest
 * already records. Seeding that record is what lets `setup --dry-run` below exercise the converged
 * path instead of stopping on the requirement.
 */
function manifest() {
  return (
    JSON.stringify(
      {
        apps: { "acme-agent": { managed: true } },
        mcpServers: [
          {
            apps: ["acme-agent"],
            catalogId: "acme/source-control",
            name: "acme-source-control",
            scope: "global",
            transport: {
              headers: { Authorization: "Bearer ${ACME_SOURCE_TOKEN}" },
              type: "http",
              url: "https://mcp.acme.example/source-control",
            },
          },
        ],
        ownership: { "acme-agent": { files: [], mcpServerNames: ["acme-source-control"] } },
        schemaVersion: 1,
        skills: [],
        snippets: [],
      },
      undefined,
      2,
    ) + "\n"
  );
}

const seed = await createSeedBuilder()
  .homeFile(".acme-agent/AGENTS.md", "# Acme instructions\n")
  .homeFile(".acme-agent/mcp.json", '{"mcpServers":{}}\n')
  .homeFile("agents/aura.json", manifest())
  .shim("acme-agent", [{ args: ["--version"], stdout: "acme-agent 1.2.3\n" }])
  .build();

/** Runs the compiled binary in the seed, tolerating the documented non-zero exit codes. */
async function runBinary(args, extraEnv = {}) {
  try {
    const { stdout } = await execFileAsync(BINARY_PATH, args, {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: { HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir, ...extraEnv },
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    if (typeof error?.code !== "number") {
      throw error;
    }
    return { exitCode: error.code, stdout: error.stdout };
  }
}

/** Every event the fake sink has delivered so far, oldest first. */
async function deliveredEvents(filePath) {
  const contents = await readFile(filePath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

try {
  const result = await runBinaryCheck({
    binaryPath: BINARY_PATH,
    seed,
  });
  const finding = result.findings.find(({ checkId }) => checkId === "acme/ACME-001");
  const app = result.report.apps.find(({ appId }) => appId === "acme-agent");

  assert.equal(
    result.exitCode,
    0,
    JSON.stringify(
      { report: result.report, stderr: result.stderr, stdout: result.stdout },
      null,
      2,
    ),
  );
  assert.equal(
    finding?.message,
    "The Acme distribution loaded its agent, skill, and MCP definition.",
  );
  assert.equal(app?.detection.version, "1.2.3");
  assert.deepEqual(result.report.diagnostics, []);
  assert.deepEqual(await seed.invocations("acme-agent"), [["--version"]]);

  // The fake telemetry sink: drive the main commands and read back what it delivered.
  const telemetryFile = join(seed.homeDir, "acme-telemetry.ndjson");
  const telemetryEnv = { ACME_TELEMETRY_FILE: telemetryFile };

  const check = await runBinary(["check"], telemetryEnv);
  assert.equal(check.exitCode, 0, check.stdout);
  const setup = await runBinary(["setup", "--dry-run"], telemetryEnv);
  assert.equal(setup.exitCode, 0, setup.stdout);
  const undo = await runBinary(["undo", "--list"], telemetryEnv);
  assert.equal(undo.exitCode, 0, undo.stdout);

  const events = await deliveredEvents(telemetryFile);
  assert.deepEqual(
    events.map(({ command, kind }) => ({ command, kind })),
    [
      { command: "check", kind: "check-run" },
      { command: "setup", kind: "setup-run" },
      { command: "undo", kind: "undo-run" },
    ],
    JSON.stringify(events, null, 2),
  );

  const [checkRun, setupRun, undoRun] = events;
  for (const event of events) {
    assert.equal(event.distroVersion, "0.3.1");
    assert.match(event.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal(checkRun.exitCode, 0);
  // The report above carries the detected `1.2.3`, but telemetry deliberately drops it: an
  // application's version is a string an external tool returned, so it stops at this boundary.
  assert.deepEqual(
    checkRun.apps.find(({ appId }) => appId === "acme-agent"),
    { appId: "acme-agent", installed: true },
  );
  assert.equal(
    checkRun.checks.some(
      ({ checkId, errors, state }) =>
        checkId === "acme/ACME-001" && errors === 1 && state === "findings",
    ),
    true,
  );
  assert.equal(setupRun.outcome, "dry-run");
  assert.ok(setupRun.actions, "a dry-run setup event should carry the planned setup actions");
  assert.equal(undoRun.outcome, "listed");

  // The user's opt-out beats the distribution's sink: nothing new may arrive.
  await runBinary(["check"], { ...telemetryEnv, DO_NOT_TRACK: "1" });
  assert.equal((await deliveredEvents(telemetryFile)).length, events.length);
} finally {
  await seed.cleanup();
}
