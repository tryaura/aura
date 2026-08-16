import { PassThrough, Readable } from "node:stream";

import { runCli, type CliDistro } from "@tryaura/aura-cli";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import { createNormalizer } from "./run-result.js";
import type { TestFileDiff, TestSeed } from "./types.js";

export interface RunSetupOptions {
  /** Setup-command flags other than `--yes`, which the runner always supplies. */
  readonly args?: readonly string[] | undefined;
  readonly distro: CliDistro;
  readonly seed: TestSeed;
}

/** What one headless `setup --yes` run printed and changed. */
export interface SetupRunResult {
  readonly diffs: readonly TestFileDiff[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Runs `setup --yes` in-process against a seed and returns snapshot-ready output.
 *
 * `--yes` because this boundary has no terminal: every question resolves to the default the wizard
 * would have proposed, which is exactly what the acceptance tests need to prove about converge and
 * end-on-green behaviour. Interactive keypress flows are covered by the CLI's own engine tests.
 */
export async function runSetup(options: RunSetupOptions): Promise<SetupRunResult> {
  const before = await captureFilesystem(options.seed);
  const stderr = createTextCapture();
  const stdout = createTextCapture();
  let exitCode = -1;

  await runCli(options.distro, {
    argv: ["setup", "--yes", ...(options.args ?? [])],
    colorDepth: 0,
    cwd: options.seed.workspaceDir,
    environmentVariables: { PATH: options.seed.pathDir },
    homeDir: options.seed.homeDir,
    setExitCode: (code) => {
      exitCode = code;
    },
    stderr: stderr.stream,
    stdin: Readable.from([]),
    stdout: stdout.stream,
  });

  const normalize = createNormalizer(options.seed);
  const after = await captureFilesystem(options.seed);
  return Object.freeze({
    diffs: diffFilesystem(before, after, normalize),
    exitCode,
    stderr: normalize(stderr.read()),
    stdout: normalize(stdout.read()),
  });
}

function createTextCapture(): { readonly read: () => string; readonly stream: PassThrough } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
  });
  return { read: () => chunks.join(""), stream };
}
