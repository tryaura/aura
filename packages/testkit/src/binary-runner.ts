import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { collectCheckResult, type SpawnedCheckRun } from "./run-result.js";
import type { RunBinaryCheckOptions, TestRunResult } from "./types.js";

/**
 * How long a compiled run may take before the runner stops waiting.
 *
 * Generous on purpose: this is the bound that turns a hang into a readable failure, not a budget
 * anyone should be tuning a passing test against.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Flags the runner supplies itself, which a caller repeating would silently duplicate. */
const RESERVED_FLAGS: ReadonlySet<string> = new Set(["--home", "--json", "--path"]);

/** Runs a compiled Aura distribution's `check --json` command against one deterministic seed. */
export async function runBinaryCheck(options: RunBinaryCheckOptions): Promise<TestRunResult> {
  if (!isAbsolute(options.binaryPath)) {
    throw new Error(`Compiled binary path must be absolute. Received: ${options.binaryPath}`);
  }
  rejectReservedFlags(options.args ?? []);

  return collectCheckResult(options.seed, () => executeBinary(options));
}

/**
 * Refuses an argument the runner already passes.
 *
 * Repeating one is not an error the CLI reports — it parses as a second occurrence and quietly wins
 * or loses depending on the flag — so the test that did it would fail somewhere else entirely.
 */
function rejectReservedFlags(args: readonly string[]): void {
  for (const arg of args) {
    const [flag] = arg.split("=");
    if (flag !== undefined && RESERVED_FLAGS.has(flag)) {
      throw new Error(
        `Check runner already supplies ${flag}. Remove it from args; the seed decides its value.`,
      );
    }
  }
}

function executeBinary(options: RunBinaryCheckOptions): Promise<SpawnedCheckRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(
        options.binaryPath,
        [
          "check",
          "--json",
          "--home",
          options.seed.homeDir,
          "--path",
          options.seed.pathDir,
          ...(options.args ?? []),
        ],
        {
          cwd: options.seed.workspaceDir,
          env: {
            HOME: options.seed.homeDir,
            NO_COLOR: "1",
            PATH: options.seed.pathDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stderr: string[] = [];
      const stdout: string[] = [];
      let timedOut = false;
      // Killed rather than abandoned: a compiled binary that never exits would otherwise outlive the
      // suite that started it, holding a seed directory the test has already deleted.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stderr.setEncoding("utf8");
      child.stdout.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr.push(chunk);
      });
      child.stdout.on("data", (chunk: string) => {
        stdout.push(chunk);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(`Could not launch compiled Aura binary: ${error.message}`, { cause: error }),
        );
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          boundary: "spawned",
          exitCode,
          signal,
          stderr: stderr.join(""),
          stdout: stdout.join(""),
          ...(timedOut ? { timedOutAfterMs: timeoutMs } : {}),
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new Error(`Could not launch compiled Aura binary: ${message}`, { cause: error }));
    }
  });
}
