import process from "node:process";

import { Builtins, Cli } from "clipanion/lib/advanced/index.js";

import { createPluginRegistry } from "@tryaura/core";

import { CheckCommand, DefaultCommand, type AuraCliContext } from "./commands.js";
import type { CliDistro, CliExitCode, CliRuntime } from "./types.js";

/** Runs one build-time-composed Aura distribution. */
export async function runCli(distro: CliDistro, runtime?: CliRuntime): Promise<CliExitCode> {
  const resolved = resolveRuntime(runtime);
  let exitCode: CliExitCode;

  try {
    const registry = createPluginRegistry(distro.plugins);
    const cli = createCli(distro, resolved.colorDepth > 0);
    const context: AuraCliContext = {
      branding: distro.branding,
      colorDepth: resolved.colorDepth,
      cwd: resolved.cwd,
      env: resolved.environmentVariables,
      registry,
      stderr: resolved.stderr,
      stdin: resolved.stdin,
      stdout: resolved.stdout,
      ...(runtime?.homeDir === undefined ? {} : { defaultHomeDir: runtime.homeDir }),
    };

    try {
      const command = cli.process(resolved.argv, context);
      exitCode = normalizeExitCode(await cli.run(command, context));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      resolved.stderr.write(`${cli.error(normalized, { colored: false })}\n`);
      exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resolved.stderr.write(`${distro.branding.displayName}: ${message}\n`);
    exitCode = 2;
  }

  applyExitCode(exitCode, runtime);
  return exitCode;
}

interface ResolvedRuntime {
  readonly argv: string[];
  readonly colorDepth: number;
  readonly cwd: string;
  readonly environmentVariables: Record<string, string | undefined>;
  readonly stderr: NonNullable<CliRuntime["stderr"]>;
  readonly stdin: NonNullable<CliRuntime["stdin"]>;
  readonly stdout: NonNullable<CliRuntime["stdout"]>;
}

function resolveRuntime(runtime: CliRuntime | undefined): ResolvedRuntime {
  return {
    argv: [...resolveValue(runtime?.argv, () => process.argv.slice(2))],
    colorDepth: resolveValue(runtime?.colorDepth, () => 0),
    cwd: resolveValue(runtime?.cwd, () => process.cwd()),
    environmentVariables: {
      ...resolveValue(runtime?.environmentVariables, () => process.env),
    },
    stderr: resolveValue(runtime?.stderr, () => process.stderr),
    stdin: resolveValue(runtime?.stdin, () => process.stdin),
    stdout: resolveValue(runtime?.stdout, () => process.stdout),
  };
}

function resolveValue<T>(value: T | undefined, fallback: () => T): T {
  return value === undefined ? fallback() : value;
}

function createCli(distro: CliDistro, enableColors: boolean): Cli<AuraCliContext> {
  const { branding } = distro;
  const cli = new Cli<AuraCliContext>({
    binaryLabel:
      branding.description === undefined
        ? branding.displayName
        : `${branding.displayName} — ${branding.description}`,
    binaryName: branding.command,
    enableCapture: false,
    enableColors,
    ...(branding.version === undefined ? {} : { binaryVersion: branding.version }),
  });

  cli.register(DefaultCommand);
  cli.register(CheckCommand);
  cli.register(Builtins.HelpCommand);
  if (branding.version !== undefined) {
    cli.register(Builtins.VersionCommand);
  }
  return cli;
}

function normalizeExitCode(exitCode: number): CliExitCode {
  if (exitCode === 0 || exitCode === 1) {
    return exitCode;
  }
  return 2;
}

function applyExitCode(exitCode: CliExitCode, runtime: CliRuntime | undefined): void {
  if (runtime?.setExitCode !== undefined) {
    runtime.setExitCode(exitCode);
    return;
  }
  if (runtime === undefined) {
    process.exitCode = exitCode;
  }
}
