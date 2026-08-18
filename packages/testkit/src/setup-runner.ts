import { Readable } from "node:stream";

import { runCli, type CliDistro } from "@tryaura/aura-cli";

import { captureFilesystem, diffFilesystem } from "./filesystem.js";
import { loopbackOnlyHttpGet } from "./http.js";
import { createNormalizer } from "./run-result.js";
import { createTextCapture } from "./text-capture.js";
import type { TestFileDiff, TestSeed } from "./types.js";

export interface RunSetupOptions {
  /** Setup-command flags other than `--yes`, which the runner always supplies. */
  readonly args?: readonly string[] | undefined;
  readonly distro: CliDistro;
  /** Extra variables visible to the run, such as a skill-directory token. `PATH` stays seeded. */
  readonly environmentVariables?: Readonly<Record<string, string>> | undefined;
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
    environmentVariables: { ...options.environmentVariables, PATH: options.seed.pathDir },
    homeDir: options.seed.homeDir,
    httpGet: loopbackOnlyHttpGet,
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
