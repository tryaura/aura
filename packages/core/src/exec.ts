import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";

import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_CHARACTERS,
  MAX_EXEC_TIMEOUT_MS,
  NOT_EXECUTABLE_EXIT_CODE,
  OUTPUT_LIMIT_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
  type Environment,
  type EnvironmentPlatform,
  type ExecRequest,
  type ExecResult,
} from "@tryaura/aura-sdk";

import { planSpawn } from "./spawn-plan.js";

interface ExecOptions {
  readonly cwd: string;
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly platform: EnvironmentPlatform;
}

const SIGNAL_EXIT_CODE_OFFSET = 128;

export function createExec(options: ExecOptions): Environment["exec"] {
  return (request) => execute(request, options);
}

function execute(request: ExecRequest, options: ExecOptions): Promise<ExecResult> {
  if (request.signal?.aborted === true) {
    return Promise.reject(abortReason(request.signal));
  }
  const timeoutMs = normalizeTimeout(request.timeoutMs);

  return new Promise((resolve, reject) => {
    const plan = planSpawn(request.command, request.args ?? [], options.platform);
    const child = spawn(plan.command, [...plan.args], {
      cwd: request.cwd ?? options.cwd,
      // Its own process group, so a timeout can kill grandchildren too. Windows has no process
      // groups; terminate() shells out to taskkill there instead.
      detached: options.platform !== "win32",
      env: options.environmentVariables,
      shell: false,
      stdio: "pipe",
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    let settled = false;
    let stderr = "";
    let stdout = "";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortOnSignal: (() => void) | undefined;

    const cleanUp = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (abortOnSignal !== undefined) {
        request.signal?.removeEventListener("abort", abortOnSignal);
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const finish = (result: ExecResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanUp();
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanUp();
      reject(error);
    };

    timeout = setTimeout(() => {
      terminate(child, options.platform);
      // Settle here rather than waiting for `close`. A grandchild that inherited the pipes holds
      // them open after its parent dies, and `close` would never fire.
      finish({
        exitCode: TIMEOUT_EXIT_CODE,
        stderr: appendNotice(stderr, `Command timed out after ${timeoutMs}ms.`),
        stdout,
      });
    }, timeoutMs);

    abortOnSignal = () => {
      terminate(child, options.platform);
      fail(abortReason(request.signal));
    };

    const abortOnOverflow = (): void => {
      terminate(child, options.platform);
      finish({
        exitCode: OUTPUT_LIMIT_EXIT_CODE,
        stderr: appendNotice(
          stderr,
          `Command produced more than ${MAX_EXEC_OUTPUT_CHARACTERS} characters on a single stream and was terminated. Output is truncated.`,
        ),
        stdout,
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
      if (stdout.length >= MAX_EXEC_OUTPUT_CHARACTERS) {
        abortOnOverflow();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
      if (stderr.length >= MAX_EXEC_OUTPUT_CHARACTERS) {
        abortOnOverflow();
      }
    });
    child.stdin.on("error", () => {
      // A child may exit without reading stdin. Its exit event still owns the command result.
    });
    child.on("error", (error) => {
      finish({
        exitCode: spawnFailureExitCode(error),
        stderr: appendNotice(stderr, error.message),
        stdout,
      });
    });
    child.on("close", (exitCode, signal) => {
      finish({
        exitCode: resolveExitCode(exitCode, signal),
        stderr: signal === null ? stderr : appendNotice(stderr, `Command was killed by ${signal}.`),
        stdout,
      });
    });
    child.stdin.end(request.input);
    request.signal?.addEventListener("abort", abortOnSignal, { once: true });
    if (request.signal?.aborted === true) {
      abortOnSignal();
    }
  });
}

/** The caller-selected reason, with the platform-standard fallback for a bare abort. */
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The command was aborted.", "AbortError");
}

/**
 * Kills the command and every process it started.
 *
 * Killing only the direct child leaves grandchildren holding the inherited pipes, which keeps the
 * command alive and its output flowing after Aura believes it is gone.
 */
function terminate(child: ChildProcess, platform: EnvironmentPlatform): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (platform === "win32") {
    // Windows cannot signal a process group. taskkill /t walks the child tree instead.
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.on("error", () => {
      child.kill("SIGKILL");
    });
    return;
  }

  try {
    // A negative pid targets the whole process group created by `detached`.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already gone, or the child died between the liveness check and the signal.
    child.kill("SIGKILL");
  }
}

function appendCapped(current: string, chunk: string): string {
  const remaining = MAX_EXEC_OUTPUT_CHARACTERS - current.length;
  if (remaining <= 0) {
    return current;
  }

  return chunk.length <= remaining
    ? `${current}${chunk}`
    : `${current}${chunk.slice(0, remaining)}`;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }

  return Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS);
}

function resolveExitCode(exitCode: number | null, signal: NodeJS.Signals | null): number {
  if (exitCode !== null) {
    return exitCode;
  }

  if (signal === null) {
    return COMMAND_NOT_FOUND_EXIT_CODE;
  }

  return SIGNAL_EXIT_CODE_OFFSET + (constants.signals[signal] ?? 0);
}

function spawnFailureExitCode(error: Error): number {
  if ("code" in error && error.code === "EACCES") {
    return NOT_EXECUTABLE_EXIT_CODE;
  }

  return COMMAND_NOT_FOUND_EXIT_CODE;
}

function appendNotice(stderr: string, message: string): string {
  if (stderr.length === 0) {
    return message;
  }

  const separator = stderr.endsWith("\n") ? "" : "\n";
  return `${stderr}${separator}${message}`;
}
