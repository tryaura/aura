import type { Finding } from "@tryaura/aura-sdk";
import type { CheckReport, CliDistro, CliExitCode } from "@tryaura/aura-cli";

/**
 * Matches any single argument in that position.
 *
 * Arity still has to match, so a response stays an exact description of one shape of invocation —
 * this only frees the positions whose value a test cannot predict, such as a temporary path.
 */
export const ANY_ARGUMENT: unique symbol = Symbol("aura-testkit.anyArgument");

/** One argument a shim matches on: an exact value, or {@link ANY_ARGUMENT}. */
export type ShimArgument = string | typeof ANY_ARGUMENT;

/**
 * One invocation a PATH shim knows how to answer.
 *
 * The first response whose arguments match wins, so order declarations from most to least specific
 * when they overlap through {@link ANY_ARGUMENT}.
 */
export interface ShimResponse {
  readonly args: readonly ShimArgument[];
  /** Defaults to zero. */
  readonly exitCode?: number | undefined;
  readonly stderr?: string | undefined;
  readonly stdout?: string | undefined;
}

/** Materialized fake machine state owned by one test. */
export interface TestSeed {
  readonly homeDir: string;
  readonly pathDir: string;
  readonly workspaceDir: string;
  /** Removes the whole temporary seed. Safe to call more than once. */
  readonly cleanup: () => Promise<void>;
  /** Disposes through `await using`, which is the leak-proof way to own a seed. */
  readonly [Symbol.asyncDispose]: () => Promise<void>;
  /**
   * Every invocation of one seeded shim, in the order it happened.
   *
   * Records invocations no response matched too, which is what turns "the shim answered `exit 2`"
   * into "the adapter asked for arguments no response declares". Empty for a command that was never
   * run, or was never seeded.
   */
  readonly invocations: (command: string) => Promise<readonly (readonly string[])[]>;
}

/** The directories a seed materialized, for file content that has to name one. */
export interface SeedRoots {
  readonly homeDir: string;
  readonly workspaceDir: string;
}

/**
 * File content, or a function producing it from the directories the seed materialized.
 *
 * Those directories are temporary and only exist once `build` has run, so a fixture whose content
 * has to contain one — a config keyed by workspace path, an absolute import — would otherwise have
 * to write that file itself, outside the builder, and hand-roll the cleanup-on-failure and
 * duplicate-path checks `build` already does.
 */
export type SeedContent = string | ((roots: SeedRoots) => string);

/** Fluent description of files and executables to materialize for a test. */
export interface TestSeedBuilder {
  homeFile(path: string, content: SeedContent): TestSeedBuilder;
  shim(command: string, responses: readonly ShimResponse[]): TestSeedBuilder;
  workspaceFile(path: string, content: SeedContent): TestSeedBuilder;
  build(): Promise<TestSeed>;
}

export interface RunCheckOptions {
  /** Check-command flags other than `--json`, which the runner always supplies. */
  readonly args?: readonly string[] | undefined;
  readonly distro: CliDistro;
  readonly seed: TestSeed;
}

/** Options for running a compiled Aura distribution against a deterministic seed. */
export interface RunBinaryCheckOptions {
  /** Check-command flags other than `--json`, `--home`, and `--path`, which the runner rejects. */
  readonly args?: readonly string[] | undefined;
  /** Absolute path to the compiled distribution executable. */
  readonly binaryPath: string;
  readonly seed: TestSeed;
  /**
   * How long the compiled run may take before it is killed. Defaults to 30 seconds.
   *
   * A run that outlives this fails with the output it had produced by then, which is the only thing
   * that distinguishes a binary that hung from a test runner that gave up on it.
   */
  readonly timeoutMs?: number | undefined;
}

export type TestFileDiffStatus = "added" | "modified" | "removed";

/**
 * One stable, snapshot-ready change under the fake HOME or workspace.
 *
 * The seeded PATH directory is deliberately not diffed: its shims would be permanent noise in every
 * snapshot. Use {@link TestSeed.invocations} to assert on what a shim did instead.
 */
export interface TestFileDiff {
  /**
   * Unified diff of the entry, whose first line is always its permission bits.
   *
   * Carrying the mode inside the patch is what makes a permission-only fix visible: without it a
   * `chmod` that changes nothing else would diff as no change at all.
   */
  readonly patch: string;
  readonly path: string;
  readonly status: TestFileDiffStatus;
}

/** Captured result of running the distribution's check command in process. */
export interface TestRunResult {
  readonly diffs: readonly TestFileDiff[];
  readonly exitCode: CliExitCode;
  /** Shorthand for `report.findings`. */
  readonly findings: readonly Finding[];
  /**
   * The whole `check --json` document.
   *
   * Assert against this rather than {@link TestRunResult.findings} alone when a test needs to prove
   * a check actually ran: a check that threw reports no findings and is explained only by
   * `report.diagnostics`.
   */
  readonly report: CheckReport;
  readonly stderr: string;
  readonly stdout: string;
}
