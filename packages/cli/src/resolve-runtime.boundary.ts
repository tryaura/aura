import { homedir } from "node:os";
import process from "node:process";

import { detectColorDepth, extractColorArguments } from "./color.js";
import { writeRunFailure } from "./command-support.js";
import { resolveProcessOutput } from "./process-output.js";
import type { CliBranding, CliRuntime } from "./types.js";

/** Set when a process-owned output failed for a reason other than a reader closing the pipe. */
interface OutputFailure {
  failed: boolean;
}

export interface ResolvedRuntime {
  readonly argv: string[];
  readonly colorDepth: number;
  readonly cwd: string;
  readonly environmentVariables: Record<string, string | undefined>;
  readonly homeDir: string;
  /** Absent means the kernel's own bounded client. */
  readonly httpGet: CliRuntime["httpGet"];
  readonly now: () => Date;
  readonly outputFailure: OutputFailure;
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
export function resolveRuntime(
  runtime: CliRuntime | undefined,
  branding: CliBranding,
): ResolvedRuntime {
  const environmentVariables = {
    ...resolveValue(runtime?.environmentVariables, () => process.env),
  };
  const colorArguments = extractColorArguments(
    resolveValue(runtime?.argv, () => process.argv.slice(2)),
  );
  const outputFailure: OutputFailure = { failed: false };
  const streams = resolveStreams(runtime, branding, outputFailure);

  return {
    argv: [...colorArguments.argv],
    colorDepth: colorArguments.noColor
      ? 0
      : resolveColorDepth(runtime, environmentVariables, streams.stdout),
    cwd: resolveValue(runtime?.cwd, () => process.cwd()),
    environmentVariables,
    homeDir: resolveValue(runtime?.homeDir, () => homedir()),
    httpGet: runtime?.httpGet,
    now: resolveValue(runtime?.now, () => () => new Date()),
    outputFailure,
    ...streams,
  };
}

/** The three process streams, resolved together so each injected one replaces its default. */
function resolveStreams(
  runtime: CliRuntime | undefined,
  branding: CliBranding,
  outputFailure: OutputFailure,
): Pick<ResolvedRuntime, "stderr" | "stdin" | "stdout"> {
  // stderr resolves first: it is where a failure of the process's own stdout gets reported. A
  // stderr that fails too has nowhere left to say so, and only the exit code carries the news.
  const stderr = resolveProcessOutput(runtime?.stderr, process.stderr, () => {
    outputFailure.failed = true;
  });
  return {
    stderr,
    stdin: resolveValue(runtime?.stdin, () => process.stdin),
    stdout: resolveProcessOutput(runtime?.stdout, process.stdout, (error) => {
      outputFailure.failed = true;
      writeRunFailure(error, branding, stderr);
    }),
  };
}

function resolveColorDepth(
  runtime: CliRuntime | undefined,
  environmentVariables: Record<string, string | undefined>,
  stdout: ResolvedRuntime["stdout"],
): number {
  return resolveValue(runtime?.colorDepth, () =>
    // An injected stream is not a terminal Aura can ask about color, and the surrounding process's
    // FORCE_COLOR is not an answer about it either: an embedder's capture stays byte-stable unless
    // that embedder asks for color itself.
    runtime?.stdout === undefined ? detectColorDepth(environmentVariables, stdout) : 0,
  );
}

function resolveValue<T>(value: T | undefined, fallback: () => T): T {
  return value === undefined ? fallback() : value;
}
