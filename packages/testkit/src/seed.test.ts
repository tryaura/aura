import { spawn } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSeedBuilder } from "./index.js";

describe("createSeedBuilder", () => {
  it("materializes nested files and exact executable shim responses", async () => {
    const seed = await createSeedBuilder()
      .homeFile(".fixture/config.json", '{"enabled":true}\n')
      .workspaceFile("nested/AGENTS.md", "workspace instructions\n")
      .shim("fixture-agent", [
        { args: ["--version"], stdout: "fixture 1.2.3\n" },
        { args: ["status"], exitCode: 7, stderr: "not ready\n" },
      ])
      .build();

    try {
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
    } finally {
      await seed.cleanup();
    }
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
    expect(() => createSeedBuilder().shim("tool", [{ args: [] }, { args: [] }])).toThrow(
      "same arguments more than once",
    );
  });

  it("cleans up idempotently", async () => {
    const seed = await createSeedBuilder().homeFile("config", "value").build();
    const root = dirname(seed.homeDir);

    await Promise.all([seed.cleanup(), seed.cleanup()]);

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

function isTestkitDirectory(entry: string): boolean {
  return entry.startsWith("aura-testkit-");
}
