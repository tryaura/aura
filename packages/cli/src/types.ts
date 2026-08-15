import type { Readable, Writable } from "node:stream";

import type { AuraPlugin } from "@tryaura/aura-sdk";
import type { PluginRegistryOptions } from "@tryaura/core";

/** Process status produced by every Aura CLI command. */
export type CliExitCode = 0 | 1 | 2;

/** Distribution-controlled names and help metadata. */
export interface CliBranding {
  /** Executable name shown in command usage. */
  readonly command: string;
  /** Product name shown in human-readable output. */
  readonly displayName: string;
  /** Short product description shown in top-level help. */
  readonly description?: string | undefined;
  /** Documentation link shown alongside human-readable reports. */
  readonly docsUrl?: string | undefined;
  /** Distribution version exposed through `--version`. */
  readonly version?: string | undefined;
}

/** Build-time composition of one Aura distribution. */
export interface CliDistro {
  readonly branding: CliBranding;
  readonly plugins: readonly AuraPlugin[];
  /**
   * Registry policy this distribution grants its own plugins, such as bare check ids.
   *
   * Distribution-owned rather than plugin-owned: the grant is only meaningful because `plugins` is
   * a build-time list this distribution controls.
   */
  readonly registry?: PluginRegistryOptions | undefined;
}

/**
 * Injectable process boundary used by tests and embedding applications.
 *
 * Every ambient value the run depends on is listed here. An embedder that supplies all of them gets
 * a run that reads nothing from the surrounding process.
 */
export interface CliRuntime {
  /** Command arguments without the executable and script path. */
  readonly argv?: readonly string[] | undefined;
  /**
   * Color depth reported to the command framework.
   *
   * Defaults to what the terminal supports, honouring `NO_COLOR` and `FORCE_COLOR`. Always no color
   * when `stdout` is injected, since the destination is then not a terminal Aura can ask.
   */
  readonly colorDepth?: number | undefined;
  /** Directory the command was invoked from. */
  readonly cwd?: string | undefined;
  /** Base environment inherited by probes. */
  readonly environmentVariables?: Readonly<Record<string, string | undefined>> | undefined;
  /** Base home directory before a `--home` override. Defaults to the operating-system home. */
  readonly homeDir?: string | undefined;
  readonly stderr?: Writable | undefined;
  readonly stdin?: Readable | undefined;
  readonly stdout?: Writable | undefined;
  /** Receives the final code. Defaults to setting `process.exitCode`. */
  readonly setExitCode?: ((exitCode: CliExitCode) => void) | undefined;
}
