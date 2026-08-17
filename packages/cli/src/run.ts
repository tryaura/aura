import { homedir } from "node:os";
import process from "node:process";

// Deep import on purpose: clipanion's ESM entry contains a directory import Node cannot resolve, so
// the package root loads only under CommonJS. This is the file its `main` points at.
import { Builtins, Cli, type Command } from "clipanion/lib/advanced/index.js";
// Deep imports again: the internal help command `cli.process` resolves `-h` to, and the parse
// error class, are not re-exported from the advanced entry.
import { HelpCommand as ClipanionHelpCommand } from "clipanion/lib/advanced/HelpCommand.js";
import { UnknownSyntaxError } from "clipanion/lib/errors.js";

import { createPluginRegistry } from "@tryaura/core";

import { CheckCommand, type AuraCliContext } from "./commands.js";
import { DefaultCommand } from "./default-command.js";
import {
  renderCheckHelp,
  renderRootHelp,
  renderSetupHelp,
  renderUndoHelp,
  renderUnknownCommand,
} from "./help.js";
import { SetupCommand } from "./setup/command.js";
import { setupAddKinds } from "./setup/steps/index.js";
import { UndoCommand } from "./undo/command.js";
import type { CliBranding, CliDistro, CliExitCode, CliRuntime } from "./types.js";

/** Runs one build-time-composed Aura distribution. */
export async function runCli(distro: CliDistro, runtime?: CliRuntime): Promise<CliExitCode> {
  const resolved = resolveRuntime(runtime);
  let exitCode: CliExitCode;

  try {
    const registry = createPluginRegistry(distro.plugins, distro.registry ?? {});
    const cli = createCli(distro, resolved.colorDepth > 0);
    const context: AuraCliContext = {
      branding: distro.branding,
      colorDepth: resolved.colorDepth,
      cwd: resolved.cwd,
      defaultHomeDir: resolved.homeDir,
      env: resolved.environmentVariables,
      registry,
      report: resolved.stdout,
      stderr: resolved.stderr,
      stdin: resolved.stdin,
      stdout: resolved.stdout,
    };

    let command: Command<AuraCliContext>;
    try {
      command = cli.process(resolved.argv, context);
    } catch (error) {
      const unknownCommand = unknownCommandInput(error, resolved.argv);
      if (unknownCommand === undefined) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        resolved.stderr.write(`${cli.error(normalized, { colored: false })}\n`);
      } else {
        resolved.stderr.write(renderUnknownCommand(distro.branding, unknownCommand));
      }
      exitCode = 2;
      applyExitCode(exitCode, runtime);
      return exitCode;
    }

    // `-h`/`--help` resolves to clipanion's internal help command; render the action-first screen
    // for whatever command the user was asking about instead of the framework's flag inventory.
    if (command instanceof ClipanionHelpCommand) {
      resolved.stdout.write(helpScreen(resolved.argv, distro.branding));
      exitCode = 0;
      applyExitCode(exitCode, runtime);
      return exitCode;
    }

    try {
      exitCode = normalizeExitCode(await cli.run(command, executionContext(command, context)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolved.stderr.write(`${distro.branding.displayName}: ${message}\n`);
      exitCode = 3;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    resolved.stderr.write(`${distro.branding.displayName}: ${message}\n`);
    exitCode = 3;
  }

  applyExitCode(exitCode, runtime);
  return exitCode;
}

interface ResolvedRuntime {
  readonly argv: string[];
  readonly colorDepth: number;
  readonly cwd: string;
  readonly environmentVariables: Record<string, string | undefined>;
  readonly homeDir: string;
  readonly stderr: NonNullable<CliRuntime["stderr"]>;
  readonly stdin: NonNullable<CliRuntime["stdin"]>;
  readonly stdout: NonNullable<CliRuntime["stdout"]>;
}

/**
 * Captures every ambient value the run depends on.
 *
 * This is the CLI's half of the boundary `Environment` draws inside the kernel: an embedder that
 * fills in the whole runtime gets a run that reads nothing from the surrounding process — including
 * the home directory, which is the one thing a caller sandboxing `HOME` would otherwise still leak.
 */
function resolveRuntime(runtime: CliRuntime | undefined): ResolvedRuntime {
  const environmentVariables = {
    ...resolveValue(runtime?.environmentVariables, () => process.env),
  };
  const stdout = resolveValue(runtime?.stdout, () => process.stdout);

  return {
    argv: [...resolveValue(runtime?.argv, () => process.argv.slice(2))],
    colorDepth: resolveValue(runtime?.colorDepth, () =>
      // An injected stream is not a terminal Aura can ask about color, so it never gets any.
      runtime?.stdout === undefined ? detectColorDepth(environmentVariables) : 0,
    ),
    cwd: resolveValue(runtime?.cwd, () => process.cwd()),
    environmentVariables,
    homeDir: resolveValue(runtime?.homeDir, () => homedir()),
    stderr: resolveValue(runtime?.stderr, () => process.stderr),
    stdin: resolveValue(runtime?.stdin, () => process.stdin),
    stdout,
  };
}

function resolveValue<T>(value: T | undefined, fallback: () => T): T {
  return value === undefined ? fallback() : value;
}

/** First tokens of every registered command path, kept next to `createCli`'s registrations. */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set(
  [
    ...(CheckCommand.paths ?? []),
    ...(SetupCommand.paths ?? []),
    ...(UndoCommand.paths ?? []),
  ].flatMap((path) => (path[0] === undefined ? [] : [path[0]])),
);

/**
 * The misspelled command behind a parse error, or undefined when the input's problem is elsewhere.
 *
 * A bad flag on a real command raises the same error class, and there clipanion's message — which
 * names the offending flag — is the more useful one, so only a genuinely unknown first word gets
 * the redirect screen.
 */
function unknownCommandInput(error: unknown, argv: readonly string[]): string | undefined {
  const first = argv[0];
  if (!(error instanceof UnknownSyntaxError) || first === undefined || first.startsWith("-")) {
    return undefined;
  }
  return KNOWN_COMMANDS.has(first) ? undefined : first;
}

/** The help screen `-h` anywhere in the input was asking for, decided by the command word. */
function helpScreen(argv: readonly string[], branding: CliBranding): string {
  const command = argv.find((token) => !token.startsWith("-"));
  if (command === "check") {
    return renderCheckHelp(branding);
  }
  if (command === "setup") {
    return renderSetupHelp(branding, setupAddKinds());
  }
  if (command === "undo") {
    return renderUndoHelp(branding);
  }
  return renderRootHelp(branding);
}

/**
 * Decides how much color the terminal should get.
 *
 * One decision for the whole run: the command framework's help and error output, the wizard, and
 * the report's severity and verdict styling all read this depth, so no layer forms a second,
 * disagreeing opinion about color. Injected streams resolve to 0, which keeps every captured run
 * free of escape sequences.
 */
function detectColorDepth(environmentVariables: Record<string, string | undefined>): number {
  const noColor = environmentVariables["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") {
    return 0;
  }

  const forceColor = environmentVariables["FORCE_COLOR"];
  if (forceColor !== undefined && forceColor !== "" && forceColor !== "0") {
    return 8;
  }

  return process.stdout.isTTY === true ? 8 : 0;
}

/**
 * Gives a command the streams it should run against.
 *
 * `--json` emits one document a script parses, so the report goes to `report` and everything else
 * the run produces — including the framework's own error output, which it writes to `stdout` — is
 * pointed at stderr. A plugin that calls `console.log` still reaches the process directly; nothing
 * here can intercept that, since the capture that would is unusable (see `createCli`).
 */
function executionContext(
  command: Command<AuraCliContext>,
  context: AuraCliContext,
): AuraCliContext {
  if (command instanceof CheckCommand && command.json) {
    return { ...context, stdout: context.stderr };
  }
  return context;
}

function createCli(distro: CliDistro, enableColors: boolean): Cli<AuraCliContext> {
  const { branding } = distro;
  const cli = new Cli<AuraCliContext>({
    binaryLabel:
      branding.description === undefined
        ? branding.displayName
        : `${branding.displayName} — ${branding.description}`,
    binaryName: branding.command,
    // Off deliberately. Capture patches `process.stdout._write` to forward to the context's stream,
    // which in a real run is that same stream — every write then recurses into itself and the
    // process wedges with no output at all. Anything a plugin prints therefore goes straight at the
    // process; see `executionContext` for what that means for `--json`.
    enableCapture: false,
    enableColors,
    ...(branding.version === undefined ? {} : { binaryVersion: branding.version }),
  });

  cli.register(DefaultCommand);
  cli.register(CheckCommand);
  cli.register(SetupCommand);
  cli.register(UndoCommand);
  // No Builtins.HelpCommand: `-h`/`--help` routes through clipanion's internal help command, which
  // `runCli` intercepts to render the action-first screens in help.ts.
  if (branding.version !== undefined) {
    cli.register(Builtins.VersionCommand);
  }
  return cli;
}

function normalizeExitCode(exitCode: number): CliExitCode {
  if (exitCode === 0 || exitCode === 1 || exitCode === 3) {
    return exitCode;
  }
  return 2;
}

function applyExitCode(exitCode: CliExitCode, runtime: CliRuntime | undefined): void {
  if (runtime?.setExitCode === undefined) {
    process.exitCode = exitCode;
    return;
  }
  runtime.setExitCode(exitCode);
}
