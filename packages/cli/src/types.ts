import type { Readable, Writable } from "node:stream";

import type {
  AuraConfigurationLayer,
  AuraPlugin,
  Environment,
  TelemetrySink,
} from "@tryaura/aura-sdk";

/** Process status produced by every Aura CLI command. */
export type CliExitCode = 0 | 1 | 2 | 3;

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

/** One long flag a distribution command accepts. */
export interface CliCommandFlag {
  /** One-line help text shown on the command's help screen. No trailing period. */
  readonly description: string;
  /**
   * Long flag as typed, such as `--tag`. Lowercase kebab-case. `--help` is claimed by the command
   * framework and `--no-color` is consumed before any command parses, so neither can be declared.
   */
  readonly flag: string;
  /** How the flag parses: a valueless switch, one value, or a repeatable value. */
  readonly kind: "array" | "boolean" | "string";
  /** Value placeholder shown on the help screen, such as `<name>`. Ignored for boolean flags. */
  readonly placeholder?: string | undefined;
}

/** One example row on a distribution command's help screen. */
export interface CliCommandExample {
  /** Arguments after the executable name, such as `sync --all`. */
  readonly args: string;
  /** What the invocation does. No trailing period. */
  readonly text: string;
}

/**
 * A parsed flag value: `boolean` flags are always present, `string` flags are absent unless given,
 * and `array` flags are always present (empty when never given).
 */
export type CliCommandFlagValue = boolean | string | readonly string[] | undefined;

/**
 * Everything one distribution-command invocation may read.
 *
 * Every ambient value is injected, mirroring {@link CliRuntime}: a command that reads only from its
 * invocation runs the same under tests, embedders, and the real process.
 */
export interface CliCommandInvocation {
  readonly branding: CliBranding;
  /** Supported color depth; 0 means the run must not emit escape sequences. */
  readonly colorDepth: number;
  /** Directory the command was invoked from. */
  readonly cwd: string;
  /** Environment variables captured at the process boundary. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Parsed flag values keyed by the flag as declared, such as `--tag`. */
  readonly flags: Readonly<Record<string, CliCommandFlagValue>>;
  /** Home directory captured at the process boundary. */
  readonly homeDir: string;
  /** The run's clock. */
  readonly now: () => Date;
  /** Positional arguments in the order given. */
  readonly positionals: readonly string[];
  readonly stderr: Writable;
  readonly stdin: Readable;
  readonly stdout: Writable;
}

/**
 * One additional top-level command a distribution registers at build time.
 *
 * Declarative on purpose: the command framework stays an implementation detail, and the same data
 * renders the command's row on the root and unknown-command screens, its own `--help` screen, and
 * the parser — so the help surface can never drift from what actually parses. The definition runs
 * with the full privileges of the process, like every other build-time contribution.
 */
export interface CliCommandDefinition {
  /**
   * Example invocations for the help screen's "Everyday use" section, most common first. Absent,
   * the screen shows the bare command word with {@link CliCommandDefinition.summary}.
   */
  readonly examples?: readonly CliCommandExample[] | undefined;
  /** Runs the command. The returned code becomes the process exit code. */
  readonly execute: (invocation: CliCommandInvocation) => Promise<CliExitCode>;
  readonly flags?: readonly CliCommandFlag[] | undefined;
  /** Footer lines for the command's help screen, such as an exit-code legend. */
  readonly helpFooters?: readonly string[] | undefined;
  /** Row text on the root and unknown-command screens. No trailing period. */
  readonly summary: string;
  /**
   * Top-level command word, such as `sync`. Lowercase kebab-case. The built-in words (`check`,
   * `setup`, `undo`) and the framework's own (`help`, `version`) are reserved.
   */
  readonly word: string;
}

/** Distribution-owned plugin registry policy exposed without leaking Aura's private core package. */
export interface CliRegistryOptions {
  /** Plugins allowed to contribute bare check ids such as `INS-001`. */
  readonly bareCheckIdPlugins?: readonly string[] | undefined;
}

/** Build-time composition of one Aura distribution. */
export interface CliDistro {
  readonly branding: CliBranding;
  /**
   * Additional top-level commands this distribution registers alongside the built-in ones.
   *
   * Distribution-owned rather than plugin-owned: a command word is global UX real estate, and the
   * build-time list is the one place that can arbitrate it. An invalid or colliding definition
   * fails the run at startup rather than shadowing a built-in at parse time.
   */
  readonly commands?: readonly CliCommandDefinition[] | undefined;
  /** Data-only defaults applied below a selected team preset. */
  readonly defaults?: AuraConfigurationLayer | undefined;
  /** Bundled preset reference used when neither the workspace nor user selected one. */
  readonly defaultPreset?: string | undefined;
  readonly plugins: readonly AuraPlugin[];
  /**
   * Registry policy this distribution grants its own plugins, such as bare check ids.
   *
   * Distribution-owned rather than plugin-owned: the grant is only meaningful because `plugins` is
   * a build-time list this distribution controls.
   */
  readonly registry?: CliRegistryOptions | undefined;
  /**
   * Where run events are sent. Absent, telemetry is a no-op and the run records nothing.
   *
   * The sink can never fail a run: throws are swallowed, and the final flush is bounded. The user
   * always wins over the distribution — `DO_NOT_TRACK` or `AURA_TELEMETRY=off` in the invoking
   * environment disables the sink outright.
   */
  readonly telemetry?: TelemetrySink | undefined;
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
   * Defaults to what the process's own stdout supports, honouring the CLI and environment color
   * policy. Always no color when `stdout` is injected, since neither that stream nor the
   * surrounding process's `FORCE_COLOR` says anything about the destination — set this to ask for
   * color there. An explicit value stays authoritative unless the command line says `--no-color`.
   */
  readonly colorDepth?: number | undefined;
  /** Directory the command was invoked from. */
  readonly cwd?: string | undefined;
  /** Base environment inherited by probes. */
  readonly environmentVariables?: Readonly<Record<string, string | undefined>> | undefined;
  /** Base home directory before a `--home` override. Defaults to the operating-system home. */
  readonly homeDir?: string | undefined;
  /**
   * Network access for the run. Defaults to the kernel's bounded TLS-only client; the testkit
   * injects a loopback-only variant so no test run can reach beyond the machine.
   */
  readonly httpGet?: Environment["httpGet"] | undefined;
  /** Clock used to stamp telemetry events. Defaults to the system clock. */
  readonly now?: (() => Date) | undefined;
  readonly stderr?: Writable | undefined;
  readonly stdin?: Readable | undefined;
  readonly stdout?: Writable | undefined;
  /** Receives the final code. Defaults to setting `process.exitCode`. */
  readonly setExitCode?: ((exitCode: CliExitCode) => void) | undefined;
}
