import { Readable } from "node:stream";

import { defineCheck, definePlugin, type Environment } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
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
    expect(capture.stdout.text).toContain("✓ Passed (1)");
    expect(capture.stdout.text).toContain("1 passed, 0 informational, 0 warnings, 0 errors");
  });

  it("emits deterministic JSON without human decoration", async () => {
    const capture = createCapture(["check", "--json"]);

    const exitCode = await runCli(distro([findingPlugin("info", [])]), capture.runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout.text)).toEqual({
      diagnostics: [],
      exitCode: 0,
      findings: [],
      passedChecks: [{ id: "fixture-info/INFO", title: "info check" }],
      skipped: [],
      status: "clean",
      summary: { errors: 0, informational: 0, passed: 1, warnings: 0 },
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

  it("rejects --fix with --json until fix records are defined", async () => {
    const capture = createCapture(["check", "--fix", "--json"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("--fix cannot be combined with --json");
  });

  it.each([["--dry-run"], ["--yes"]])("rejects %s without --fix", async (flag) => {
    const capture = createCapture(["check", flag]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain(`${flag} only means something with --fix`);
  });

  it("rejects --dry-run with --yes", async () => {
    const capture = createCapture(["check", "--fix", "--dry-run", "--yes"]);

    expect(await runCli(distro([findingPlugin("info", [])]), capture.runtime)).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("--dry-run and --yes contradict each other");
  });

  it("refuses an interactive setup when stdout is redirected", async () => {
    const capture = createCapture(["setup"]);
    const stdin = Object.assign(Readable.from([]), { isTTY: true });

    expect(await runCli(distro(), { ...capture.runtime, stdin })).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("stdin and stdout must both be terminals");
  });

  it("uses branding in top-level help and version output", async () => {
    const help = createCapture([]);
    const version = createCapture(["--version"]);

    await runCli(distro(), help.runtime);
    await runCli(distro(), version.runtime);

    expect(help.stdout.text).toContain("Acme Doctor — Agent setup doctor");
    expect(help.stdout.text).toContain("acme check");
    expect(help.stdout.text).toContain("https://example.com/docs");
    expect(version.stdout.text.trim()).toBe("1.2.3");
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

  it("groups findings and applies warning/error exit-code precedence", async () => {
    const warning = createCapture(["check"]);
    const error = createCapture(["check"]);

    expect(await runCli(distro([findingPlugin("warn")]), warning.runtime)).toBe(1);
    expect(warning.stdout.text).toContain("! Warnings (1)");
    expect(await runCli(distro([findingPlugin("error")]), error.runtime)).toBe(2);
    expect(error.stdout.text).toContain("✗ Errors (1)");
  });

  it("lists the applications that were looked for and not found", async () => {
    const plugin = definePlugin({
      adapters: [fixtureAdapter(() => ({ installed: false }))],
      apiVersion: 1,
      checks: [],
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
    });
    const capture = createCapture(["check"]);

    await runCli(distro([plugin]), capture.runtime);

    expect(capture.stdout.text).toContain("Not found (1)");
    expect(capture.stdout.text).toContain("Fixture App");
  });

  it("maps invalid invocations to exit code two and stderr", async () => {
    const capture = createCapture(["unknown"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("Unknown Syntax Error");
  });

  it("skips a check that throws and keeps the findings of the ones that ran", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(
      distro([throwingPlugin(), findingPlugin("warn")]),
      capture.runtime,
    );

    expect(exitCode).toBe(2);
    expect(capture.stdout.text).toContain("! Warnings (1)");
    expect(capture.stdout.text).toContain("Run errors (1)");
    expect(capture.stdout.text).toContain("[throwing/CHECK:check]");
    expect(capture.stdout.text).not.toContain("✓ Passed");
    expect(capture.stdout.text).toContain("0 passed, 0 informational, 1 warnings, 0 errors");
    expect(capture.stdout.text).not.toContain("secret source contents");
    expect(capture.stderr.text).toBe("");
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
    expect(await runCli(distro([bare]), refused.runtime)).toBe(2);
    expect(refused.stderr.text).toContain("Acme Doctor:");
  });
});
