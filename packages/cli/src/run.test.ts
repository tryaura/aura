import { Readable, Writable } from "node:stream";

import {
  defineAdapter,
  defineCheck,
  definePlugin,
  type AuraPlugin,
  type Environment,
  type Severity,
} from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";
import type { CliDistro, CliExitCode, CliRuntime } from "./types.js";

const BRANDING = {
  command: "acme",
  description: "Agent setup doctor",
  displayName: "Acme Doctor",
  docsUrl: "https://example.com/docs",
  version: "1.2.3",
};

describe("runCli", () => {
  it("runs check end to end with zero plugins", async () => {
    const capture = createCapture(["check"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(capture.exitCodes).toEqual([0]);
    expect(capture.stdout.text).toContain("Acme Doctor check");
    expect(capture.stdout.text).toContain("✓");
    expect(capture.stdout.text).toContain("No checks reported issues.");
    expect(capture.stderr.text).toBe("");
  });

  it("emits deterministic JSON without human decoration", async () => {
    const capture = createCapture(["check", "--json"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout.text)).toEqual({
      diagnostics: [],
      exitCode: 0,
      findings: [],
      passedChecks: [],
      status: "clean",
      summary: { errors: 0, informational: 0, passed: 0, warnings: 0 },
    });
    expect(capture.stdout.text).not.toContain("✓");
    expect(capture.stderr.text).toBe("");
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
    const adapter = defineAdapter({
      async detect(environment) {
        observed = environment;
        return { installed: false };
      },
      displayName: "Fixture",
      files: () => [],
      id: "fixture",
      parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
      supportedRange: ">=1",
    });
    const plugin = definePlugin({
      adapters: [adapter],
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

  it("groups findings and applies warning/error exit-code precedence", async () => {
    const warning = createCapture(["check"]);
    const error = createCapture(["check"]);

    expect(await runCli(distro([findingPlugin("warn")]), warning.runtime)).toBe(1);
    expect(warning.stdout.text).toContain("! Warnings (1)");
    expect(await runCli(distro([findingPlugin("error")]), error.runtime)).toBe(2);
    expect(error.stdout.text).toContain("✗ Errors (1)");
  });

  it("maps invalid invocations to exit code two and stderr", async () => {
    const capture = createCapture(["unknown"]);

    const exitCode = await runCli(distro(), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stdout.text).toBe("");
    expect(capture.stderr.text).toContain("Unknown Syntax Error");
  });

  it("does not expose thrown check details", async () => {
    const check = defineCheck({
      defaultSeverity: "error",
      detect: () => {
        throw new Error("secret source contents");
      },
      explain: "Test check.",
      fixability: "manual",
      id: "throwing/CHECK",
      scope: "global",
      title: "Throwing check",
    });
    const plugin = definePlugin({
      apiVersion: 1,
      checks: [check],
      id: "throwing",
      name: "Throwing",
      version: "1.0.0",
    });
    const capture = createCapture(["check"]);

    const exitCode = await runCli(distro([plugin]), capture.runtime);

    expect(exitCode).toBe(2);
    expect(capture.stderr.text).toContain("check failed unexpectedly");
    expect(capture.stderr.text).not.toContain("secret source contents");
  });
});

function distro(plugins: readonly AuraPlugin[] = []): CliDistro {
  return { branding: BRANDING, plugins };
}

function findingPlugin(severity: Severity): AuraPlugin {
  const check = defineCheck({
    defaultSeverity: severity,
    detect: () => [{ id: `${severity}-finding`, message: `${severity} finding` }],
    explain: "Test check.",
    fixability: "manual",
    id: `fixture-${severity}/${severity.toUpperCase()}`,
    scope: "global",
    title: `${severity} check`,
  });
  return definePlugin({
    apiVersion: 1,
    checks: [check],
    id: `fixture-${severity}`,
    name: `Fixture ${severity}`,
    version: "1.0.0",
  });
}

class TextOutput extends Writable {
  text = "";

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    callback();
  }
}

function createCapture(argv: readonly string[]): {
  readonly exitCodes: CliExitCode[];
  readonly runtime: CliRuntime;
  readonly stderr: TextOutput;
  readonly stdout: TextOutput;
} {
  const exitCodes: CliExitCode[] = [];
  const stderr = new TextOutput();
  const stdout = new TextOutput();
  return {
    exitCodes,
    runtime: {
      argv,
      cwd: process.cwd(),
      environmentVariables: { PATH: "/usr/bin" },
      setExitCode: (exitCode) => {
        exitCodes.push(exitCode);
      },
      stderr,
      stdin: Readable.from([]),
      stdout,
    },
    stderr,
    stdout,
  };
}
