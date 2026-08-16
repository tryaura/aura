import { Readable, Writable } from "node:stream";

import {
  defineAdapter,
  defineCheck,
  definePlugin,
  type Adapter,
  type AuraPlugin,
  type DetectedFinding,
  type Environment,
  type Severity,
} from "@tryaura/aura-sdk";

import type { CliBranding, CliDistro, CliExitCode, CliRuntime } from "./types.js";

/** Branding for a fictional distribution, so tests assert on names no real product uses. */
export const BRANDING: CliBranding = {
  command: "acme",
  description: "Agent setup doctor",
  displayName: "Acme Doctor",
  docsUrl: "https://example.com/docs",
  version: "1.2.3",
};

export function distro(plugins: readonly AuraPlugin[] = []): CliDistro {
  return { branding: BRANDING, plugins };
}

/** An adapter that reports whatever the test wants, and parses nothing. */
export function fixtureAdapter(
  detect: (environment: Environment) => { installed: boolean },
): Adapter {
  return defineAdapter({
    detect: (environment) => Promise.resolve(detect(environment)),
    displayName: "Fixture App",
    files: () => [],
    id: "fixture",
    parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
    supportedRange: ">=1",
  });
}

/** A plugin with one detectable adapter and one that no machine has installed. */
export function appsPlugin(): AuraPlugin {
  return definePlugin({
    adapters: [
      defineAdapter({
        detect: () => Promise.resolve({ installed: true, version: "1.2.3" }),
        displayName: "Installed App",
        files: () => [],
        id: "installed-app",
        parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
        supportedRange: ">=1 <2",
      }),
      defineAdapter({
        detect: () => Promise.resolve({ installed: false }),
        displayName: "Missing App",
        files: () => [],
        id: "missing-app",
        installHint: "brew install missing-app",
        parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
        supportedRange: ">=1",
      }),
    ],
    apiVersion: 1,
    id: "fixture-apps",
    name: "Fixture Apps",
    version: "1.0.0",
  });
}

/** A plugin whose check throws the kind of message that quotes the file that broke it. */
export function throwingPlugin(): AuraPlugin {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "error",
        detect: () => {
          throw new Error("secret source contents");
        },
        explain: "Test check.",
        fixability: "manual",
        id: "throwing/CHECK",
        scope: "global",
        title: "Throwing check",
      }),
    ],
    id: "throwing",
    name: "Throwing",
    version: "1.0.0",
  });
}

/** A plugin with one check that reports the given findings at the given severity. */
export function findingPlugin(
  severity: Severity,
  findings: readonly DetectedFinding[] = [
    { id: `${severity}-finding`, message: `${severity} finding` },
  ],
): AuraPlugin {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: severity,
        detect: () => findings,
        explain: "Test check.",
        fixability: "manual",
        id: `fixture-${severity}/${severity.toUpperCase()}`,
        scope: "global",
        title: `${severity} check`,
      }),
    ],
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

/**
 * A fully injected runtime, so a run reads nothing from the process it happens to be in.
 *
 * Every ambient value is supplied, including the home directory: leaving one out would make the
 * test depend on the machine running it.
 */
export function createCapture(argv: readonly string[]): {
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
      homeDir: "/fixture/home",
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
