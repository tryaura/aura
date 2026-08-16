import { delimiter, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

import { describeFailure, type EnvironmentBootOptions } from "@tryaura/core";

import { safe } from "./render.js";
import type { CliBranding, CliExitCode } from "./types.js";

/**
 * Whether Aura can hold a conversation on this input.
 *
 * `isTTY` is present on the process's own stdin and absent on the plain stream an embedder injects,
 * so the property test doubles as "is anybody there to answer".
 */
export function isTerminal(stdin: Readable): boolean {
  return "isTTY" in stdin && stdin.isTTY === true;
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
  },
  home: string | undefined,
  pathValue: string | undefined,
): EnvironmentBootOptions {
  return {
    cwd: context.cwd,
    environmentVariables: context.env,
    homeDir: home ?? context.defaultHomeDir,
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
  subject: string,
  branding: CliBranding,
  withDetail: boolean,
  stderr: Writable,
): CliExitCode {
  stderr.write(
    `${branding.displayName}: ${subject} failed unexpectedly. This is a bug in a plugin or the CLI.\n`,
  );
  stderr.write(
    withDetail
      ? `  ${safe(describeFailure(error))}\n`
      : `  Re-run with --detail to see what failed.\n`,
  );
  return 2;
}
