import { delimiter, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

// Deep import on purpose: see the note in run.boundary.ts.
import { Option } from "clipanion/lib/advanced/index.js";

import type { TelemetryCommand, WorkspaceModel } from "@tryaura/aura-sdk";
import {
  applyRequiredMcpServers,
  describeFailure,
  type EnvironmentBootOptions,
  type RequiredMcpProjection,
} from "@tryaura/core";

import { withRepoMcpCatalog, type RuntimeConfigResult } from "./runtime-config.js";
import { safe } from "./safe-text.js";
import { commandFailedEvent } from "./telemetry-events.js";
import type { TelemetryRecorder } from "./telemetry.js";
import type { CliBranding, CliExitCode } from "./types.js";

/**
 * Projects preset requirements onto a check scan's model.
 *
 * A trusted repository's provided MCP definitions join the catalog first, so a repository can
 * require a server it defines itself and `check` reports that requirement the way setup would.
 */
export function projectConfiguredModel(
  model: WorkspaceModel,
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
): RequiredMcpProjection {
  return applyRequiredMcpServers(
    withRepoMcpCatalog(model, configured.repoPreset),
    configured.config,
  );
}

/** The `--home` override every scanning command shares. */
export function homeOption(): string | undefined {
  return Option.String("--home", { description: "Override the home directory." });
}

/** The `--path` override every scanning command shares. */
export function pathOption(): string | undefined {
  return Option.String("--path", { description: "Override the executable search path." });
}

/** Reports an invalid command line the one way every command does. */
export function writeOptionRejection(
  context: { readonly branding: CliBranding; readonly stderr: Writable },
  rejection: string,
): CliExitCode {
  context.stderr.write(`${context.branding.displayName}: ${rejection}\n`);
  return 2;
}

/** Writes the one-line operational failure a run reports when it cannot finish its own work. */
export function writeRunFailure(error: unknown, branding: CliBranding, stderr: Writable): void {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${branding.displayName}: ${message}\n`);
}

/**
 * Whether Aura can hold a conversation through this stream.
 *
 * `isTTY` is present on the process's terminal streams and absent on plain streams an embedder
 * injects, so checking both input and output prevents an interactive prompt from being redirected.
 */
export function isTerminal(stream: Readable | Writable): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

/**
 * Refuses a path override that cannot mean what the user intended.
 *
 * Both flags are handed to adapters, which build the paths Aura reads out of them. A relative
 * `--home` would otherwise surface much later as one "this is a bug in the adapter" diagnostic per
 * installed application, blaming every plugin for a typo in the command line.
 */
export function rejectInvalidPathOptions(
  home: string | undefined,
  pathValue: string | undefined,
): string | undefined {
  if (home !== undefined && !isAbsolute(home)) {
    return `--home must be an absolute path. Received: ${safe(home)}`;
  }

  if (pathValue !== undefined) {
    // An empty entry means "the current directory" to most tools, which is how a search path
    // starts resolving executables out of whatever directory Aura happened to be run from.
    const loose = pathValue
      .split(delimiter)
      .filter((entry) => !isAbsolute(entry))
      .map((entry) => (entry === "" ? "(empty)" : safe(entry)));

    if (loose.length > 0) {
      return `--path must list absolute directories separated by "${delimiter}". Not absolute: ${loose.join(", ")}`;
    }
  }

  return undefined;
}

/** The environment one command run scans against, honoring its `--home` and `--path` overrides. */
export function environmentOptions(
  context: {
    readonly cwd: string;
    readonly defaultHomeDir: string;
    readonly env: Record<string, string | undefined>;
    readonly httpGet?: EnvironmentBootOptions["httpGet"] | undefined;
    readonly now?: EnvironmentBootOptions["now"] | undefined;
  },
  home: string | undefined,
  pathValue: string | undefined,
): EnvironmentBootOptions {
  return {
    cwd: context.cwd,
    environmentVariables: context.env,
    homeDir: home ?? context.defaultHomeDir,
    ...(context.httpGet === undefined ? {} : { httpGet: context.httpGet }),
    ...(context.now === undefined ? {} : { now: context.now }),
    ...(pathValue === undefined ? {} : { path: pathValue }),
  };
}

/**
 * Reports a failure that is not a plugin misbehaving in a way core already models.
 *
 * The thrown text is withheld by default for the same reason a scan diagnostic withholds it: it
 * may quote the contents of a file that holds an API token.
 */
export function reportUnexpectedFailure(
  error: unknown,
  subject: TelemetryCommand,
  branding: CliBranding,
  withDetail: boolean,
  stderr: Writable,
  telemetry: TelemetryRecorder,
): CliExitCode {
  stderr.write(
    `${branding.displayName}: ${subject} failed unexpectedly. This is a bug in a plugin or the CLI.\n`,
  );
  stderr.write(
    withDetail
      ? `  ${safe(describeFailure(error))}\n`
      : `  Re-run with --detail to see what failed.\n`,
  );
  telemetry.record(commandFailedEvent(subject, 3));
  return 3;
}
