import { spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ANY_ARGUMENT, createSeedBuilder } from "./index.js";

describe("createSeedBuilder", () => {
  it("materializes nested files and exact executable shim responses", async () => {
    await using seed = await createSeedBuilder()
      .homeFile(".fixture/config.json", '{"enabled":true}\n')
      .workspaceFile("nested/AGENTS.md", "workspace instructions\n")
      .shim("fixture-agent", [
        { args: ["--version"], stdout: "fixture 1.2.3\n" },
        { args: ["status"], exitCode: 7, stderr: "not ready\n" },
      ])
      .build();

    await expect(readFile(join(seed.homeDir, ".fixture/config.json"), "utf8")).resolves.toBe(
      '{"enabled":true}\n',
    );
    await expect(readFile(join(seed.workspaceDir, "nested/AGENTS.md"), "utf8")).resolves.toBe(
      "workspace instructions\n",
    );
    expect((await lstat(join(seed.pathDir, "fixture-agent"))).mode & 0o111).toBe(0o111);

    await expect(runShim(seed.pathDir, ["--version"])).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "fixture 1.2.3\n",
    });
    await expect(runShim(seed.pathDir, ["status"])).resolves.toEqual({
      exitCode: 7,
      stderr: "not ready\n",
      stdout: "",
    });
    await expect(runShim(seed.pathDir, ["unknown", "argument"])).resolves.toEqual({
      exitCode: 2,
      stderr: "aura-testkit: unmatched invocation: fixture-agent unknown argument\n",
      stdout: "",
    });
  });

  it("answers an argument a test cannot predict", async () => {
    await using seed = await createSeedBuilder()
      .shim("fixture-agent", [
        { args: ["mcp", "add", ANY_ARGUMENT], stdout: "added\n" },
        { args: [ANY_ARGUMENT], exitCode: 3 },
      ])
      .build();

    await expect(runShim(seed.pathDir, ["mcp", "add", "/tmp/whatever-42"])).resolves.toMatchObject({
      exitCode: 0,
      stdout: "added\n",
    });
    await expect(runShim(seed.pathDir, ["anything"])).resolves.toMatchObject({ exitCode: 3 });
    // Arity still has to match, so a wildcard never swallows an invocation of a different shape.
    await expect(runShim(seed.pathDir, ["mcp", "add"])).resolves.toMatchObject({ exitCode: 2 });
  });

  it("records every invocation, including the ones no response matched", async () => {
    await using seed = await createSeedBuilder()
      .shim("fixture-agent", [{ args: ["--version"], stdout: "fixture 1.2.3\n" }])
      .build();

    await runShim(seed.pathDir, ["--version"]);
    await runShim(seed.pathDir, ["config", "", "two\nlines"]);
    await runShim(seed.pathDir, []);

    await expect(seed.invocations("fixture-agent")).resolves.toEqual([
      ["--version"],
      ["config", "", "two\nlines"],
      [],
    ]);
    await expect(seed.invocations("never-seeded")).resolves.toEqual([]);
  });

  it("rejects invalid and duplicate fixture declarations", () => {
    expect(() => createSeedBuilder().homeFile("", "value")).toThrow("non-empty relative");
    expect(() => createSeedBuilder().homeFile("../outside", "value")).toThrow("inside its root");
    expect(() => createSeedBuilder().workspaceFile("/absolute", "value")).toThrow(
      "non-empty relative",
    );
    expect(() => createSeedBuilder().homeFile("config", "one").homeFile("./config", "two")).toThrow(
      "already seeded",
    );
    expect(() => createSeedBuilder().shim("nested/tool", [{ args: [] }])).toThrow(
      "portable executable name",
    );
    expect(() => createSeedBuilder().shim("..", [{ args: [] }])).toThrow(
      "portable executable name",
    );
    expect(() => createSeedBuilder().shim(".", [{ args: [] }])).toThrow("portable executable name");
    expect(() => createSeedBuilder().shim("tool", [{ args: [] }, { args: [] }])).toThrow(
      "same arguments more than once",
    );
    expect(() =>
      createSeedBuilder().shim("tool", [{ args: [ANY_ARGUMENT] }, { args: [ANY_ARGUMENT] }]),
    ).toThrow("same arguments more than once");
  });

  it("resolves its root to a path other tools report the same way", async () => {
    await using seed = await createSeedBuilder().homeFile("config", "value").build();

    await expect(realpathOf(seed.homeDir)).resolves.toBe(seed.homeDir);
    await expect(realpathOf(seed.workspaceDir)).resolves.toBe(seed.workspaceDir);
  });

  it("cleans up idempotently", async () => {
    const seed = await createSeedBuilder().homeFile("config", "value").build();
    const root = dirname(seed.homeDir);

    await Promise.all([seed.cleanup(), seed.cleanup()]);

    await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("cleans up through await using", async () => {
    let root = "";
    {
      await using seed = await createSeedBuilder().homeFile("config", "value").build();
      root = dirname(seed.homeDir);
      await expect(lstat(root)).resolves.toBeDefined();
    }

    await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("removes a partial seed when materialization fails", async () => {
    const before = new Set((await readdir(tmpdir())).filter(isTestkitDirectory));
    const build = createSeedBuilder()
      .homeFile("blocked", "file\n")
      .homeFile("blocked/nested", "cannot be written\n")
      .build();

    await expect(build).rejects.toBeDefined();

    const after = (await readdir(tmpdir())).filter(isTestkitDirectory);
    expect(after.filter((entry) => !before.has(entry))).toEqual([]);
  });
});

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function runShim(pathDir: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const executable = ["fixture", "agent"].join("-");
    const child = spawn(executable, [...args], {
      env: { PATH: pathDir },
      stdio: "pipe",
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 128, stderr, stdout });
    });
  });
}

/** Asks a child process, rather than Node, so the answer is the one a real tool would report. */
async function realpathOf(path: string): Promise<string> {
  const { stdout } = await new Promise<ProcessResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", 'cd "$1" && pwd -P', "sh", path], { stdio: "pipe" });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 128, stderr: "", stdout: output });
    });
  });
  return stdout.trim();
}

function isTestkitDirectory(entry: string): boolean {
  return entry.startsWith("aura-testkit-");
}
