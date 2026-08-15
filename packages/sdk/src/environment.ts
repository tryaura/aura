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
 * A request to run an external command.
 *
 * The command and its arguments are passed to the operating system directly. Aura core never
 * spawns a shell, so argument values are not word-split, glob-expanded, or otherwise interpreted:
 * untrusted strings are safe to place in {@link ExecRequest.args}. Never assemble a single
 * `command` string with interpolated values.
 *
 * The child process environment is supplied by Aura core and cannot be set by the plugin, so a
 * plugin cannot inject `NODE_OPTIONS`, `LD_PRELOAD`, or similar into the child.
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
   * Milliseconds before the child is killed.
   *
   * Defaults to {@link DEFAULT_EXEC_TIMEOUT_MS} and is clamped to {@link MAX_EXEC_TIMEOUT_MS}.
   */
  readonly timeoutMs?: number | undefined;
}

/** The outcome of an {@link ExecRequest}. A timeout or spawn failure reports a non-zero exit code. */
export interface ExecResult {
  /** Exit code, or a non-zero value if the command timed out or could not be spawned. */
  readonly exitCode: number;
  /** Captured standard error. */
  readonly stderr: string;
  /** Captured standard output. */
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
