/* eslint-disable max-lines -- one end-to-end CLI matrix shares the same injected runtime fixtures. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { defineAdapter, defineCheck, definePlugin, type Environment } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import { parseCheckReport } from "./test-support/check-output-schema.js";
import {
  BRANDING,
  createCapture,
  distro,
  findingPlugin,
  fixtureAdapter,
  throwingPlugin,
} from "./testing.js";

const ESCAPE = String.fromCharCode(27);
const RIGHT_TO_LEFT_OVERRIDE = "\u202e";
const ZERO_WIDTH_SPACE = "\u200b";

describe("runCli", () => {
  it("refuses to call a run with no checks clean", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.exitCodes).toEqual([2]);
    expect(capture.stdout.text).toContain("Acme Doctor check");
    expect(capture.stdout.text).toContain("Nothing to check");
    expect(capture.stdout.text).toContain("ships no plugins");
    expect(capture.stderr.text).toBe("");
  });

  it("reports a clean run when checks ran and found nothing", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(distro([findingPlugin("info", [])]), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("✓ 1 check passed · 0 applications detected");
    expect(capture.stdout.text).toContain("0 errors · 0 warnings · 0 suggestions");
  });

  it("performs remote MCP probes only with --online", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected the MCP probe fixture to listen on a TCP port.");
      }
      const plugin = remoteMcpProbePlugin(`http://127.0.0.1:${String(address.port)}/mcp`);
      const offline = createCapture(["check"]);
      const online = createCapture(["check", "--online"]);

      expect(await runCli(distro([plugin]), offline.runtime)).toBe(0);
      expect(requests).toBe(0);
      expect(await runCli(distro([plugin]), online.runtime)).toBe(0);
      expect(requests).toBe(1);
      expect(online.stdout.text).toContain("remote probe failed");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  });

  it("emits deterministic JSON without human decoration", async () => {
    const capture = createCapture(["check", "--json"]);

    const exitCode = await runCli(distro([findingPlugin("info", [])]), capture.runtime);

    expect(exitCode).toBe(0);
    expect(parseCheckReport(capture.stdout.text)).toEqual({
      apps: [],
      configuration: {
        repositoryPreset: { path: ".aura/preset.json", status: "held" },
      },
      diagnostics: [],
      findings: [],
      kind: "check-report",
      passedChecks: [{ id: "fixture-info/INFO", title: "info check" }],
      schemaVersion: 1,
      status: "clean",
      summary: {
        categories: { INFO: { errors: 0, informational: 0, passed: 1, warnings: 0 } },
        diagnostics: 0,
        errors: 0,
        exitCode: 0,
        informational: 0,
        passed: 1,
        warnings: 0,
      },
    });
    expect(capture.stdout.text).not.toContain("✓");
    expect(capture.stderr.text).toBe("");
  });

  it("keeps everything but the document off the machine-readable stream", async () => {
    const capture = createCapture(["check", "--json", "--home", "relative/home"]);

    expect(await runCli(distro(), capture.runtime)).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("--home must be an absolute path");
  });

  it("reports a JSON fix run without mixing progress into stdout", async () => {
    const capture = createCapture(["check", "--fix", "--json"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(0);
    expect(parseCheckReport(capture.stdout.text)).toMatchObject({
      fixes: [],
      kind: "check-report",
    });
    expect(capture.stderr.text).toContain("Nothing to fix");
  });

  it("omits all-noop JSON fixes without rescanning", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "aura-cli-noop-"));
    const root = await realpath(temporaryRoot);
    const path = join(root, "current.md");
    try {
      await writeFile(path, "current", "utf8");
      let detections = 0;
      const plugin = definePlugin({
        adapters: [
          fixtureAdapter(() => {
            detections += 1;
            return { installed: true };
          }),
        ],
        apiVersion: 1,
        checks: [
          defineCheck({
            defaultSeverity: "warn",
            detect: () => [{ id: "noop", message: "Already current." }],
            explain: "Why this matters.\n\nRun the automatic fix.",
            fix: () => ({
              operations: [{ content: "current", path, type: "write" }],
              summary: "Keep the fixture current.",
            }),
            fixability: "auto",
            id: "fixture-noop/NOOP",
            scope: "project",
            title: "No-op fixture",
          }),
        ],
        id: "fixture-noop",
        name: "Fixture No-op",
        version: "1.0.0",
      });
      const capture = createCapture(["check", "--fix", "--yes", "--json"]);

      const exitCode = await runCli(distro([plugin]), {
        ...capture.runtime,
        cwd: root,
        homeDir: root,
      });

      expect(exitCode).toBe(0);

      expect(parseCheckReport(capture.stdout.text).fixes).toEqual([]);
      expect(capture.stderr.text).toContain(
        "The planned fixes already match the current file contents.",
      );
      expect(detections).toBe(1);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("redacts JSON fix diffs unless --detail is requested", async () => {
    const plugin = definePlugin({
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [{ id: "write", message: "Write a fixture file." }],
          explain: "Why this matters.\n\nRun the automatic fix.",
          fix: () => ({
            operations: [
              {
                content: "potentially secret contents\n",
                path: join(process.cwd(), ".context", "check-json-fixture.md"),
                type: "write",
              },
            ],
            summary: "Write the fixture file.",
          }),
          fixability: "auto",
          id: "fixture-json/AUTO",
          scope: "project",
          title: "Automatic JSON check",
        }),
      ],
      id: "fixture-json",
      name: "Fixture JSON",
      version: "1.0.0",
    });
    const redacted = createCapture(["check", "--fix", "--dry-run", "--json"]);
    const detailed = createCapture(["check", "--fix", "--dry-run", "--json", "--detail"]);

    expect(await runCli(distro([plugin]), redacted.runtime)).toBe(0);
    const redactedReport = parseCheckReport(redacted.stdout.text);
    expect(redactedReport.fixes?.[0]?.operations[0]).not.toHaveProperty("diff");
    expect(redacted.stdout.text).not.toContain("potentially secret contents");
    expect(await runCli(distro([plugin]), detailed.runtime)).toBe(0);
    const detailedReport = parseCheckReport(detailed.stdout.text);
    expect(detailedReport.fixes?.[0]?.operations[0]?.diff).toContain("diff --aura");
    expect(detailed.stdout.text).toContain("potentially secret contents");
  });

  it("accepts the frozen JSON version and rejects invalid version usage", async () => {
    const pinned = createCapture(["check", "--json", "--json-version", "1"]);
    const missingJson = createCapture(["check", "--json-version", "1"]);
    const unsupported = createCapture(["check", "--json", "--json-version", "2"]);

    expect(await runCli(distro([findingPlugin("info", [])]), pinned.runtime)).toBe(0);
    expect(parseCheckReport(pinned.stdout.text)).toMatchObject({ schemaVersion: 1 });
    expect(await runCli(distro(), missingJson.runtime)).toBe(2);
    expect(missingJson.stderr.text).toContain("--json-version only means something with --json");
    expect(await runCli(distro(), unsupported.runtime)).toBe(2);
    expect(unsupported.stderr.text).toContain("Supported versions: 1");
  });

  it("rejects --verbose where no human scan report exists", async () => {
    const json = createCapture(["check", "--verbose", "--json"]);
    const explain = createCapture(["check", "--verbose", "--explain", "fixture/CHECK"]);

    expect(await runCli(distro(), json.runtime)).toBe(2);
    expect(json.stderr.text).toContain("--verbose cannot be combined with --json");
    expect(await runCli(distro(), explain.runtime)).toBe(2);
    expect(explain.stderr.text).toContain("--verbose cannot be combined with --explain");
  });

  it.each([["--dry-run"], ["--interactive"], ["--yes"]])(
    "rejects %s without --fix",
    async (flag) => {
      const capture = createCapture(["check", flag]);

      expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(2);
      expect(capture.stdout.text).toBe("");
      expect(capture.stderr.text).toContain(`${flag} only means something with --fix`);
    },
  );

  it("keeps the retired --interactive flag as a hidden compatibility alias", async () => {
    const capture = createCapture(["check", "--fix", "--interactive"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(0);
    expect(capture.stdout.text).toContain("Nothing to fix");
    expect(capture.stderr.text).toBe("");
  });

  it("rejects the retired --interactive alias with --yes", async () => {
    const capture = createCapture(["check", "--fix", "--interactive", "--yes"]);

    expect(await runCli(distro(), capture.runtime)).toBe(2);
    expect(capture.stderr.text).toContain("--interactive and --yes contradict each other");
  });

  it("rejects --dry-run with --yes", async () => {
    const capture = createCapture(["check", "--fix", "--dry-run", "--yes"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("--dry-run and --yes contradict each other");
  });

  it("runs a JSON fix without asking, even when prompts could use terminal stderr", async () => {
    const capture = createCapture(["check", "--fix", "--json"]);
    const stdin = Object.assign(Readable.from([]), { isTTY: true });
    Object.assign(capture.stderr, { isTTY: true });

    expect(await runCli(distro([findingPlugin("info", [])]), { ...capture.runtime, stdin })).toBe(
      0,
    );
    expect(parseCheckReport(capture.stdout.text)).toMatchObject({ kind: "check-report" });
    expect(capture.stderr.text).toContain("Nothing to fix");
  });

  it("rejects --only with --explain and unknown selectors before scanning", async () => {
    let invoked = false;
    const plugin = definePlugin({
      adapters: [
        fixtureAdapter(() => {
          invoked = true;
          return { installed: false };
        }),
      ],
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [],
          explain: "Why this matters.\n\nHow to inspect it.",
          fixability: "manual",
          id: "fixture/ENV-001",
          scope: "global",
          title: "Environment check",
        }),
      ],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const explain = createCapture(["check", "--explain", "fixture/ENV-001", "--only", "ENV"]);
    const unknown = createCapture(["check", "--only", "unknown"]);

    expect(await runCli(distro([plugin]), explain.runtime)).toBe(2);
    expect(explain.stderr.text).toContain("--explain cannot be combined with --only");
    expect(await runCli(distro([plugin]), unknown.runtime)).toBe(2);
    expect(unknown.stderr.text).toContain("Valid categories: ENV");
    expect(unknown.stderr.text).toContain("Valid app IDs: fixture");
    expect(invoked).toBe(false);
  });

  it("refuses an interactive setup when stdout is redirected", async () => {
    const capture = createCapture(["setup"]);
    const stdin = Object.assign(Readable.from([]), { isTTY: true });

    expect(await runCli(distro(), { ...capture.runtime, stdin })).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("stdin and stdout must both be terminals");
  });

  it("validates --add kinds before scanning", async () => {
    let invoked = false;
    const plugin = definePlugin({
      adapters: [
        fixtureAdapter(() => {
          invoked = true;
          return { installed: false };
        }),
      ],
      apiVersion: 1,
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["setup", "--add", "unknown", "--yes"]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(2);
    expect(capture.stderr.text).toContain("unknown --add kind: unknown");
    expect(capture.stderr.text).toContain("Valid kinds: snippet");
    expect(invoked).toBe(false);
  });

  // The rejected kind is quoted back from argv, so it reaches the terminal as text Aura did not
  // write. An escape sequence surviving that trip can repaint the line into one that reads green.
  it("neutralizes control characters in a rejected --add kind", async () => {
    const hostile = `snippet[2K\rall checks passed`;
    const capture = createCapture(["setup", "--add", hostile, "--yes"]);

    expect(await runCli(distro(), capture.runtime)).toBe(2);
    expect(capture.stderr.text).not.toContain("");
    expect(capture.stderr.text).not.toContain("\r");
    expect(capture.stderr.text).toContain("unknown --add kind: snippet [2K all checks passed");
  });

  it("reports the full-setup prerequisite for --add snippet", async () => {
    const capture = createCapture(["setup", "--add", "snippet", "--yes"]);

    expect(await runCli(distro(), capture.runtime)).toBe(2);
    expect(capture.stderr.text).toContain(
      "the Snippets step needs a readable shared instruction file",
    );
    expect(capture.stderr.text).toContain("Run acme setup to establish it");
  });

  it("uses branding in top-level help and version output", async () => {
    const help = createCapture([]);
    const version = createCapture(["--version"]);

    await runCli(distro(), help.runtime);
    await runCli(distro(), version.runtime);

    expect(help.stdout.text).toContain("Acme Doctor 1.2.3 — Agent setup doctor");
    expect(help.stdout.text).toContain("Get started");
    expect(help.stdout.text).toContain("acme check");
    expect(help.stdout.text).toContain("https://example.com/docs");
    expect(version.stdout.text.trim()).toBe("1.2.3");
  });

  it("renders the action-first help screens for --help at every level", async () => {
    const root = createCapture(["--help"]);
    const check = createCapture(["check", "-h"]);
    const setup = createCapture(["setup", "--help"]);
    const undo = createCapture(["undo", "--help"]);

    expect(await runCli(distro(), root.runtime)).toBe(0);
    expect(await runCli(distro(), check.runtime)).toBe(0);
    expect(await runCli(distro(), setup.runtime)).toBe(0);
    expect(await runCli(distro(), undo.runtime)).toBe(0);

    expect(root.stdout.text).toContain("Everyday use");
    expect(root.stdout.text).toContain("acme setup");
    expect(check.stdout.text).toContain("acme check — Inspect the current AI agent setup");
    expect(check.stdout.text).toContain("--only <filter>");
    expect(check.stdout.text).toContain("Exit codes:");
    expect(setup.stdout.text).toContain("acme setup — Set up this machine interactively");
    expect(setup.stdout.text).toContain("--dry-run");
    expect(setup.stdout.text).toContain("--add <kind>");
    expect(setup.stderr.text).toBe("");
    expect(undo.stdout.text).toContain("acme undo — Restore files from an Aura backup");
    expect(undo.stdout.text).toContain("--list");
    expect(undo.stdout.text).toContain("<backup-id>");
  });

  it("accepts --no-color globally before and after a command", async () => {
    const root = createCapture(["--no-color", "--help"]);
    const before = createCapture(["--no-color", "check", "--help"]);
    const after = createCapture(["check", "--no-color", "--help"]);
    const version = createCapture(["--no-color", "--version"]);

    expect(await runCli(distro(), root.runtime)).toBe(0);
    expect(await runCli(distro(), before.runtime)).toBe(0);
    expect(await runCli(distro(), after.runtime)).toBe(0);
    expect(await runCli(distro(), version.runtime)).toBe(0);
    expect(root.stderr.text).toBe("");
    expect(before.stdout.text).toContain("acme check — Inspect the current AI agent setup");
    expect(after.stdout.text).toBe(before.stdout.text);
    expect(version.stdout.text).toBe("1.2.3\n");
  });

  it("passes --home and --path overrides into the environment", async () => {
    let observed: Environment | undefined;
    const plugin = definePlugin({
      adapters: [
        fixtureAdapter((environment) => {
          observed = environment;
          return { installed: false };
        }),
      ],
      apiVersion: 1,
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--home", "/fake/home", "--path", "/fake/bin"]);

    await runCli(distro([plugin]), capture.runtime);

    expect(observed?.homeDir).toBe("/fake/home");
    expect(observed?.pathEntries).toEqual(["/fake/bin"]);
  });

  it("does not invoke adapters excluded by --only", async () => {
    const invoked: string[] = [];
    const plugin = definePlugin({
      adapters: ["claude-code", "cursor"].map((id) =>
        defineAdapter({
          detect: () => {
            invoked.push(id);
            return Promise.resolve({ installed: false });
          },
          displayName: id,
          files: () => [],
          id,
          parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
          supportedRange: ">=1",
        }),
      ),
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [],
          explain: "Why this matters.\n\nHow to inspect it.",
          fixability: "manual",
          id: "fixture/ENV-001",
          scope: "global",
          title: "Environment check",
        }),
      ],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--only", "claude"]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(0);
    expect(invoked).toEqual(["claude-code"]);
  });

  it("captures the home directory at the process boundary", async () => {
    let observed: Environment | undefined;
    const plugin = definePlugin({
      adapters: [
        fixtureAdapter((environment) => {
          observed = environment;
          return { installed: false };
        }),
      ],
      apiVersion: 1,
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check"]);

    await runCli(distro([plugin]), { ...capture.runtime, homeDir: "/sandbox" });

    expect(observed?.homeDir).toBe("/sandbox");
  });

  it("rejects path overrides that cannot mean what the user intended", async () => {
    const home = createCapture(["check", "--home", "relative/home"]);
    const search = createCapture(["check", "--path", "/usr/bin:"]);

    expect(await runCli(distro(), home.runtime)).toBe(2);
    expect(home.stderr.text).toContain("--home must be an absolute path");
    expect(home.stdout.text).toBe("");
    expect(await runCli(distro(), search.runtime)).toBe(2);
    expect(search.stderr.text).toContain("(empty)");
  });

  it("classifies manual findings while completed checks exit successfully", async () => {
    const warning = createCapture(["check"]);
    const error = createCapture(["check"]);

    expect(await runCli(distro([findingPlugin("warn")]), warning.runtime)).toBe(0);
    expect(warning.stdout.text).toContain("Manual attention (1)");
    expect(warning.stdout.text).toContain("! warn finding");
    expect(await runCli(distro([findingPlugin("error")]), error.runtime)).toBe(0);
    expect(error.stdout.text).toContain("✗ error finding");
  });

  it("lists the applications that were looked for and not found", async () => {
    const plugin = definePlugin({
      adapters: [
        fixtureAdapter(() => ({ installed: false })),
        defineAdapter({
          detect: () => Promise.resolve({ installed: false }),
          displayName: "Scopeless App",
          files: () => [],
          id: "scopeless",
          parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
          supportedRange: ">=1",
        }),
      ],
      apiVersion: 1,
      checks: [],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--verbose"]);

    await runCli(distro([plugin]), capture.runtime);

    expect(capture.stdout.text).toContain("Not found (2)");
    expect(capture.stdout.text).toContain("Fixture App — looked for the fixture CLI on PATH");
    expect(capture.stdout.text).toContain("Scopeless App — not found");
    expect(capture.stdout.text).toContain("Run acme setup to install and manage any of them");
  });

  it("does not claim where it looked for an adapter whose detection threw", async () => {
    const plugin = definePlugin({
      adapters: [
        defineAdapter({
          detect: () => Promise.reject(new Error("adapter exploded")),
          detectionScope: "the broken CLI on PATH",
          displayName: "Broken App",
          files: () => [],
          id: "broken-app",
          parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
          supportedRange: ">=1",
        }),
      ],
      apiVersion: 1,
      checks: [],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--verbose"]);

    await runCli(distro([plugin]), capture.runtime);

    expect(capture.stdout.text).toContain("Broken App failed during detect");
    expect(capture.stdout.text).toContain("Broken App — not found");
    expect(capture.stdout.text).not.toContain("looked for");
  });

  it("redirects an unknown command to the command list on stderr", async () => {
    const capture = createCapture(["unknown"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("acme: unknown command 'unknown'");
    expect(capture.stderr.text).toContain("acme check");
    expect(capture.stderr.text).not.toContain("Unknown Syntax Error");
  });

  it("keeps the parser's own message for a bad flag on a real command", async () => {
    const capture = createCapture(["check", "--nope"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("Unknown Syntax Error");
  });

  it("skips a check that throws and keeps the findings of the ones that ran", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(
      distro([throwingPlugin(), findingPlugin("warn")]),
      capture.runtime,
    );

    expect(exitCode).toBe(3);
    expect(capture.stdout.text).toContain("Manual attention (1)");
    expect(capture.stdout.text).toContain("! warn finding");
    expect(capture.stdout.text).toContain("Run errors (1)");
    expect(capture.stdout.text).toContain("[throwing/CHECK:check]");
    expect(capture.stdout.text).not.toContain("✓ Passed checks");
    expect(capture.stdout.text).toContain("0 errors · 1 warning · 0 suggestions");
    expect(capture.stdout.text).not.toContain("secret source contents");
    expect(capture.stderr.text).toBe("");
  });

  it("uses exit code three for a throwing adapter and still emits its app record", async () => {
    const plugin = definePlugin({
      adapters: [
        defineAdapter({
          detect: () => Promise.reject(new Error("adapter exploded")),
          displayName: "Broken App",
          files: () => [],
          id: "broken-app",
          parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
          supportedRange: ">=1",
        }),
      ],
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [],
          explain: "Why this matters.\n\nHow to inspect it.",
          fixability: "manual",
          id: "fixture/ENV-001",
          scope: "global",
          title: "Environment check",
        }),
      ],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--json"]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(3);
    expect(parseCheckReport(capture.stdout.text)).toMatchObject({
      apps: [{ appId: "broken-app", detection: { installed: false }, displayName: "Broken App" }],
      status: "operational-error",
      summary: { exitCode: 3 },
    });
  });

  it("uses exit code three and a failed record when fix preparation fails", async () => {
    const plugin = definePlugin({
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [{ id: "invalid", message: "Invalid fix." }],
          explain: "Why this matters.\n\nRun the automatic fix.",
          fix: () => ({
            operations: [{ content: "blocked", path: "/outside-aura-roots", type: "write" }],
            summary: "Write outside the managed roots.",
          }),
          fixability: "auto",
          id: "fixture/AUTO",
          scope: "global",
          title: "Invalid automatic check",
        }),
      ],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check", "--fix", "--yes", "--json"]);

    expect(await runCli(distro([plugin]), capture.runtime)).toBe(3);
    expect(parseCheckReport(capture.stdout.text)).toMatchObject({
      diagnostics: [{ id: "core/fix-plan", phase: "fix" }],
      fixes: [
        {
          findingId: "invalid",
          operations: [{ effect: "conflict", paths: ["/outside-aura-roots"] }],
          status: "failed",
        },
      ],
      status: "operational-error",
    });
  });

  it("surfaces what a check reported only when asked", async () => {
    const capture = createCapture(["check", "--detail"]);

    await runCli(distro([throwingPlugin()]), capture.runtime);

    expect(capture.stdout.text).toContain("secret source contents");
  });

  it("strips control and Unicode format characters out of text a plugin supplied", async () => {
    const capture = createCapture(["check"]);
    const plugin = findingPlugin("warn", [
      {
        id: "escaped",
        message: `before${ESCAPE}[2K${ESCAPE}[1G${RIGHT_TO_LEFT_OVERRIDE}middle${ZERO_WIDTH_SPACE}after`,
      },
    ]);

    await runCli(distro([plugin]), capture.runtime);

    expect(capture.stdout.text).not.toContain(ESCAPE);
    expect(capture.stdout.text).not.toContain(RIGHT_TO_LEFT_OVERRIDE);
    expect(capture.stdout.text).not.toContain(ZERO_WIDTH_SPACE);
    expect(capture.stdout.text).toContain("before [2K [1G middle after");
  });

  it("truncates finding messages and details in human output", async () => {
    const capture = createCapture(["check"]);
    const message = "m".repeat(501);
    const details = "d".repeat(501);
    const plugin = findingPlugin("warn", [{ details, id: "long", message }]);

    await runCli(distro([plugin]), capture.runtime);

    expect(capture.stdout.text).toContain(`${"m".repeat(500)}…`);
    expect(capture.stdout.text).toContain(`${"d".repeat(500)}…`);
    expect(capture.stdout.text).not.toContain(message);
    expect(capture.stdout.text).not.toContain(details);
  });

  it("does not split a surrogate pair at the finding-text limit", async () => {
    const capture = createCapture(["check"]);
    const message = `${"m".repeat(499)}🙂tail`;

    await runCli(distro([findingPlugin("warn", [{ id: "unicode", message }])]), capture.runtime);

    expect(capture.stdout.text).toContain(`${"m".repeat(499)}🙂…`);
    expect(capture.stdout.text).not.toContain("�");
  });

  it("grants bare check ids only where the distribution said so", async () => {
    const bare = definePlugin({
      apiVersion: 1,
      checks: [
        defineCheck({
          defaultSeverity: "warn",
          detect: () => [],
          explain: "Test check.",
          fixability: "manual",
          id: "INS-001",
          scope: "global",
          title: "Bare check",
        }),
      ],
      id: "official",
      name: "Official",
      version: "1.0.0",
    });
    const granted = createCapture(["check"]);
    const refused = createCapture(["check"]);

    expect(
      await runCli(
        { branding: BRANDING, plugins: [bare], registry: { bareCheckIdPlugins: ["official"] } },
        granted.runtime,
      ),
    ).toBe(0);
    expect(await runCli(distro([bare]), refused.runtime)).toBe(3);
    expect(refused.stderr.text).toContain("Acme Doctor:");
  });

  it("lists no backups for undo on a machine nothing has changed", async () => {
    const capture = createCapture(["undo", "--list"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.stdout.text).toContain("No backups.");
  });

  it("refuses to restore without a terminal to confirm on", async () => {
    const capture = createCapture(["undo"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain(
      "stdin and stdout must both be terminals before Acme Doctor can ask to restore",
    );
  });

  it("refuses contradictory undo options", async () => {
    const contradiction = createCapture(["undo", "--dry-run", "--yes"]);
    expect(await runCli(distro(), contradiction.runtime)).toBe(2);
    expect(contradiction.stderr.text).toContain("--dry-run and --yes contradict each other");

    const listRestore = createCapture(["undo", "--list", "--yes"]);
    expect(await runCli(distro(), listRestore.runtime)).toBe(2);
    expect(listRestore.stderr.text).toContain("--list only lists backups");
  });

  it("names undo in the command overview", async () => {
    const capture = createCapture([]);

    await runCli(distro(), capture.runtime);

    expect(capture.stdout.text).toContain("undo");
  });
});

function remoteMcpProbePlugin(url: string) {
  return definePlugin({
    adapters: [
      defineAdapter({
        detect: () => Promise.resolve({ installed: true }),
        displayName: "Remote Fixture",
        files: () => [],
        id: "remote-fixture",
        parse: () => ({
          instructionFiles: [],
          mcpServers: [
            {
              appId: "remote-fixture",
              name: "remote",
              scope: "global",
              sourceId: "remote-fixture.mcp.global",
              transport: { type: "http", url },
            },
          ],
          skills: [],
        }),
        supportedRange: ">=1",
      }),
    ],
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "error",
        detect: (model) =>
          model.mcpServers.some((server) =>
            server.probes?.some((probe) => probe.kind === "url" && probe.status === "error"),
          )
            ? [{ id: "remote", message: "remote probe failed" }]
            : [],
        explain: "The remote fixture should be reachable.",
        fixability: "manual",
        id: "remote-probe/MCP-003",
        scope: "global",
        title: "Remote fixture is reachable",
      }),
    ],
    id: "remote-probe",
    name: "Remote Probe",
    version: "1.0.0",
  });
}
