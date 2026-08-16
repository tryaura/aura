import { Readable } from "node:stream";

import { runCli } from "@tryaura/aura-cli";

import { collectCheckResult } from "./run-result.js";
import { createTextCapture } from "./text-capture.js";
import type { RunCheckOptions, TestRunResult } from "./types.js";

/** Runs `check --json` without reading process state and returns snapshot-ready output. */
export async function runCheck(options: RunCheckOptions): Promise<TestRunResult> {
  return collectCheckResult(options.seed, async () => {
    const stderr = createTextCapture();
    const stdout = createTextCapture();
    let appliedExitCode: number | undefined;
    const exitCode = await runCli(options.distro, {
      argv: ["check", "--json", ...(options.args ?? [])],
      colorDepth: 0,
      cwd: options.seed.workspaceDir,
      environmentVariables: { PATH: options.seed.pathDir },
      homeDir: options.seed.homeDir,
      setExitCode: (code) => {
        appliedExitCode = code;
      },
      stderr: stderr.stream,
      stdin: Readable.from([]),
      stdout: stdout.stream,
    });

    return {
      appliedExitCode,
      boundary: "in-process",
      exitCode,
      stderr: stderr.read(),
      stdout: stdout.read(),
    };
  });
}
