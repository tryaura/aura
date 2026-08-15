/** Operating systems Aura runs on. */
export type EnvironmentPlatform = "darwin" | "linux" | "win32";

/**
 * Timeout applied by Aura core when {@link ExecRequest.timeoutMs} is omitted.
 *
 * A subprocess is never unbounded: detection runs once per installed adapter, so a command that
 * blocks on input or never exits would otherwise stall the entire scan.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/**
 * Upper bound Aura core clamps {@link ExecRequest.timeoutMs} to.
 *
 * A plugin cannot opt out of the ceiling by requesting a larger value.
 */
export const MAX_EXEC_TIMEOUT_MS = 120_000;

/**
 * Characters Aura core retains per output stream before it truncates and kills the command.
 *
 * Output is buffered in memory, so an unbounded stream would exhaust the heap. The limit applies
 * to {@link ExecResult.stdout} and {@link ExecResult.stderr} independently.
 */
export const MAX_EXEC_OUTPUT_CHARACTERS = 10_000_000;

/** {@link ExecResult.exitCode} when a command was killed for exceeding its timeout. */
export const TIMEOUT_EXIT_CODE = 124;

/** {@link ExecResult.exitCode} when a command was killed for exceeding the output limit. */
export const OUTPUT_LIMIT_EXIT_CODE = 125;

/** {@link ExecResult.exitCode} when a command was found but could not be executed. */
export const NOT_EXECUTABLE_EXIT_CODE = 126;

/** {@link ExecResult.exitCode} when a command could not be found on {@link Environment.pathEntries}. */
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;

/**
 * A request to run an external command.
 *
 * The command and its arguments are passed to the operating system directly. Aura core never
 * spawns a shell, so argument values are not word-split, glob-expanded, or otherwise interpreted:
 * untrusted strings are safe to place in {@link ExecRequest.args}. Never assemble a single
 * `command` string with interpolated values.
 *
 * The child process environment is supplied by Aura core and cannot be set by the plugin. Aura
 * core also strips the loader variables that turn any subprocess into an execution vector
 * (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, and similar), so neither a plugin nor
 * the ambient shell can inject code into a child.
 *
 * Every other variable is inherited from the shell Aura was invoked from, including credentials
 * such as `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY`. A command receives whatever the developer's
 * shell holds, so treat a plugin that runs commands as trusted with those secrets.
 */
export interface ExecRequest {
  /** Arguments passed to the command verbatim, without shell interpretation. */
  readonly args?: readonly string[] | undefined;
  /**
   * Executable to run.
   *
   * A bare name is resolved against {@link Environment.pathEntries}, which makes it vulnerable to
   * a hijacked `PATH`. Once {@link AdapterDetection.executablePath} is known, pass that absolute
   * path here instead.
   */
  readonly command: string;
  /** Working directory. Defaults to {@link Environment.cwd}. */
  readonly cwd?: string | undefined;
  /** Data written to the child's stdin, which is then closed. */
  readonly input?: string | undefined;
  /**
   * Milliseconds before the child and its descendants are killed.
   *
   * Defaults to {@link DEFAULT_EXEC_TIMEOUT_MS} and is clamped to {@link MAX_EXEC_TIMEOUT_MS}. A
   * value that is zero, negative, or not finite is replaced by {@link DEFAULT_EXEC_TIMEOUT_MS}:
   * there is no way to request an unbounded command.
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * The outcome of an {@link ExecRequest}. Resolves for every outcome and never rejects.
 *
 * Failures Aura core itself produced are reported with a reserved {@link ExecResult.exitCode} so
 * they stay distinguishable from a command that ran and reported failure:
 * {@link TIMEOUT_EXIT_CODE}, {@link OUTPUT_LIMIT_EXIT_CODE}, {@link NOT_EXECUTABLE_EXIT_CODE}, and
 * {@link COMMAND_NOT_FOUND_EXIT_CODE}. Each also appends an explanatory line to
 * {@link ExecResult.stderr}.
 */
export interface ExecResult {
  /**
   * Exit code of the command.
   *
   * A command killed by a signal reports `128 + signal`, matching shell convention. See the
   * reserved codes above for failures Aura core produced.
   */
  readonly exitCode: number;
  /** Captured standard error, truncated at {@link MAX_EXEC_OUTPUT_CHARACTERS}. */
  readonly stderr: string;
  /** Captured standard output, truncated at {@link MAX_EXEC_OUTPUT_CHARACTERS}. */
  readonly stdout: string;
}

/**
 * Ambient state injected into plugins, so nothing reads `process` or the clock directly.
 *
 * Only {@link Adapter.detect}, {@link Adapter.files}, and the {@link SkillSource} methods receive
 * an `Environment`. Checks and fixes never do — see {@link Check}.
 */
export interface Environment {
  /** Directory Aura was invoked from. */
  readonly cwd: string;
  /** Runs an external command. See {@link ExecRequest} for the safety guarantees. */
  readonly exec: (request: ExecRequest) => Promise<ExecResult>;
  /** The current user's home directory. */
  readonly homeDir: string;
  /** The current time. Injected so plugin behavior stays deterministic under test. */
  readonly now: () => Date;
  /** `PATH` split into entries, in resolution order. */
  readonly pathEntries: readonly string[];
  /** The host operating system. */
  readonly platform: EnvironmentPlatform;
}
