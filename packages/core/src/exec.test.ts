import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { promisify } from "node:util";

import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  MAX_EXEC_OUTPUT_CHARACTERS,
  NOT_EXECUTABLE_EXIT_CODE,
  OUTPUT_LIMIT_EXIT_CODE,
  TIMEOUT_EXIT_CODE,
} from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createEnvironment } from "./index.js";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Environment.exec", () => {
  it("uses the captured HOME, PATH, cwd, arguments, and stdin without a shell", async () => {
    const root = await createTemporaryDirectory();
    const bin = join(root, "bin");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const alternateCwd = join(root, "alternate");
    const command = await writeShim(bin);
    await Promise.all([mkdir(home), mkdir(workspace), mkdir(alternateCwd)]);
    const environmentVariables: Record<string, string | undefined> = {
      PRESERVED: "captured",
    };
    const environment = createEnvironment({
      cwd: workspace,
      environmentVariables,
      homeDir: home,
      path: bin,
      platform: "linux",
    });

    environmentVariables["PRESERVED"] = "changed";
    const expectedCwd = await realpath(alternateCwd);
    const result = await environment.exec({
      args: ["$HOME", "*.md"],
      command,
      cwd: alternateCwd,
      input: "hello from stdin\n",
    });

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        "arg1=$HOME",
        "arg2=*.md",
        "stdin=hello from stdin",
        `cwd=${expectedCwd}`,
        `home=${home}`,
        `path=${bin}`,
        "preserved=captured",
        "",
      ].join("\n"),
    });
  });

  it("defaults subprocesses to Environment.cwd", async () => {
    const root = await createTemporaryDirectory();
    const bin = join(root, "bin");
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const command = await writeShim(bin);
    await Promise.all([mkdir(home), mkdir(workspace)]);
    const environment = createEnvironment({
      cwd: workspace,
      environmentVariables: {},
      homeDir: home,
      path: bin,
      platform: "darwin",
    });
    const expectedCwd = await realpath(workspace);

    const result = await environment.exec({ command });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`cwd=${expectedCwd}\n`);
  });

  it("reports a missing command as exit code 127 instead of a plausible failure code", async () => {
    const environment = createEnvironment({
      cwd: "/",
      environmentVariables: {},
      homeDir: "/fake/home",
      path: "",
      platform: "linux",
    });

    const result = await environment.exec({ command: "aura-command-that-does-not-exist" });

    expect(result.exitCode).toBe(COMMAND_NOT_FOUND_EXIT_CODE);
    expect(result.stderr).toContain("ENOENT");
  });

  it("reports a command that cannot be executed as exit code 126", async () => {
    const root = await createTemporaryDirectory();
    const command = join(root, "not-executable");
    await writeFile(command, "#!/bin/sh\n", "utf8");
    await chmod(command, 0o644);
    const environment = createTestEnvironment();

    const result = await environment.exec({ command });

    expect(result.exitCode).toBe(NOT_EXECUTABLE_EXIT_CODE);
  });

  it("reports a signalled process as 128 plus the signal number", async () => {
    const environment = createTestEnvironment();

    const result = await environment.exec({
      args: ["-e", 'process.kill(process.pid, "SIGTERM")'],
      command: process.execPath,
    });

    expect(result.exitCode).toBe(128 + constants.signals.SIGTERM);
    expect(result.stderr).toContain("killed by SIGTERM");
  });

  it("kills commands at their timeout and returns exit code 124", async () => {
    const environment = createTestEnvironment();

    const result = await environment.exec({
      args: ["-e", "setInterval(() => {}, 1_000)"],
      command: process.execPath,
      timeoutMs: 25,
    });

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.stderr).toContain("Command timed out after 25ms.");
  });

  it("kills a command and its descendants when the caller aborts", async () => {
    const marker = `aura-aborted-probe-${process.pid}`;
    const environment = createTestEnvironment();
    const controller = new AbortController();
    const pending = environment.exec({
      args: [
        "-e",
        `require("child_process").spawn(process.execPath, ["-e", "/*${marker}*/setInterval(() => {}, 1_000)"], { stdio: "inherit" }); setInterval(() => {}, 1_000);`,
      ],
      command: process.execPath,
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await setTimeoutPromise(250);

    controller.abort();

    await rejected;
    await setTimeoutPromise(500);
    expect(await countProcessesMatching(marker)).toBe(0);
  }, 10_000);

  it("times out even when a grandchild inherits the pipes and outlives its parent", async () => {
    // A child that leaves a grandchild holding stdout never emits `close`, so a timeout that
    // waits for `close` hangs forever instead of returning.
    const environment = createTestEnvironment();

    const result = await environment.exec({
      args: [
        "-e",
        `require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "inherit" }); setInterval(() => {}, 1_000);`,
      ],
      command: process.execPath,
      timeoutMs: 250,
    });

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
  }, 10_000);

  it("kills the whole process group so a timeout leaves no orphans behind", async () => {
    // Unique per run: a stray from an earlier run would otherwise be counted as this run's orphan.
    const marker = `aura-orphan-probe-${process.pid}`;
    const environment = createTestEnvironment();

    await environment.exec({
      args: [
        "-e",
        `require("child_process").spawn(process.execPath, ["-e", "/*${marker}*/setInterval(() => {}, 1_000)"], { stdio: "inherit" }); setInterval(() => {}, 1_000);`,
      ],
      command: process.execPath,
      timeoutMs: 250,
    });
    await setTimeoutPromise(500);

    expect(await countProcessesMatching(marker)).toBe(0);
  }, 10_000);

  it("truncates and terminates a command that floods a stream", async () => {
    const environment = createTestEnvironment();

    const result = await environment.exec({
      args: [
        "-e",
        `const block = "x".repeat(1024 * 1024); for (let i = 0; i < 64; i += 1) { process.stdout.write(block); }`,
      ],
      command: process.execPath,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(OUTPUT_LIMIT_EXIT_CODE);
    expect(result.stdout.length).toBe(MAX_EXEC_OUTPUT_CHARACTERS);
    expect(result.stderr).toContain("was terminated");
  }, 30_000);

  it("uses the default timeout for invalid timeout values", async () => {
    const environment = createTestEnvironment();

    const result = await environment.exec({
      args: ["-e", 'process.stdout.write("ok")'],
      command: process.execPath,
      timeoutMs: Number.NaN,
    });

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
  });
});

async function countProcessesMatching(marker: string): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-eo", "command"]);
  return stdout.split("\n").filter((line) => line.includes(marker) && !line.includes("ps -eo"))
    .length;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-environment-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createTestEnvironment() {
  return createEnvironment({
    cwd: "/",
    environmentVariables: {},
    homeDir: "/fake/home",
    path: "",
    platform: "linux",
  });
}

async function writeShim(bin: string): Promise<string> {
  await mkdir(bin);
  const command = join(bin, "aura-environment-shim");
  await writeFile(
    command,
    [
      "#!/bin/sh",
      "IFS= read -r input || true",
      "printf 'arg1=%s\\n' \"$1\"",
      "printf 'arg2=%s\\n' \"$2\"",
      "printf 'stdin=%s\\n' \"$input\"",
      "printf 'cwd=%s\\n' \"$(/bin/pwd)\"",
      "printf 'home=%s\\n' \"$HOME\"",
      "printf 'path=%s\\n' \"$PATH\"",
      "printf 'preserved=%s\\n' \"$PRESERVED\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(command, 0o755);
  return "aura-environment-shim";
}
