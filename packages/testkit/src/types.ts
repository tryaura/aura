import type { Finding } from "@tryaura/aura-sdk";
import type { CliDistro, CliExitCode } from "@tryaura/aura-cli";

/** One exact invocation a PATH shim knows how to answer. */
export interface ShimResponse {
  readonly args: readonly string[];
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
}

/** Fluent description of files and executables to materialize for a test. */
export interface TestSeedBuilder {
  homeFile(path: string, content: string): TestSeedBuilder;
  shim(command: string, responses: readonly ShimResponse[]): TestSeedBuilder;
  workspaceFile(path: string, content: string): TestSeedBuilder;
  build(): Promise<TestSeed>;
}

export interface RunCheckOptions {
  /** Check-command flags other than `--json`, which the runner always supplies. */
  readonly args?: readonly string[] | undefined;
  readonly distro: CliDistro;
  readonly seed: TestSeed;
}

export type TestFileDiffStatus = "added" | "modified" | "removed";

/** One stable, snapshot-ready change under the fake HOME or workspace. */
export interface TestFileDiff {
  readonly patch: string;
  readonly path: string;
  readonly status: TestFileDiffStatus;
}

/** Captured result of running the distribution's check command in process. */
export interface TestRunResult {
  readonly diffs: readonly TestFileDiff[];
  readonly exitCode: CliExitCode;
  readonly findings: readonly Finding[];
  readonly stderr: string;
  readonly stdout: string;
}
