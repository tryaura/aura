import type { Readable, Writable } from "node:stream";

import type { AuraPlugin } from "@tryaura/aura-sdk";

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
}

/** Injectable process boundary used by tests and embedding applications. */
export interface CliRuntime {
  /** Command arguments without the executable and script path. */
  readonly argv?: readonly string[] | undefined;
  /** Color depth reported to the command framework. Defaults to no color. */
  readonly colorDepth?: number | undefined;
  /** Directory the command was invoked from. */
  readonly cwd?: string | undefined;
  /** Base environment inherited by probes. */
  readonly environmentVariables?: Readonly<Record<string, string | undefined>> | undefined;
  /** Base home directory before a `--home` override. */
  readonly homeDir?: string | undefined;
  readonly stderr?: Writable | undefined;
  readonly stdin?: Readable | undefined;
  readonly stdout?: Writable | undefined;
  /** Receives the final code. When omitted, callers can use the return value. */
  readonly setExitCode?: ((exitCode: CliExitCode) => void) | undefined;
}
