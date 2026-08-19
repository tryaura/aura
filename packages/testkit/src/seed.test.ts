import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import { parseAuraManifest } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { ANY_ARGUMENT, createSeedBuilder } from "./index.js";
import { assertSupportedPlatform } from "./seed.boundary.js";

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

    await expect(seed.invocations("fixture-agent")).resolves.toEqual([]);
    await runShim(seed.pathDir, ["--version"]);
    await runShim(seed.pathDir, ["config", "", "two\nlines"]);
    await runShim(seed.pathDir, []);

    await expect(seed.invocations("fixture-agent")).resolves.toEqual([
      ["--version"],
      ["config", "", "two\nlines"],
      [],
    ]);
    await expect(seed.invocations("never-seeded")).rejects.toThrow(
      "Unknown shim command: never-seeded. Known shims: fixture-agent.",
    );
  });

  it("fails fast when seed shims cannot run on the host platform", () => {
    expect(() => assertSupportedPlatform("win32")).toThrow(
      "Aura testkit requires a POSIX shell and cannot build seeds on Windows.",
    );
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

  it("adds workspace trust without discarding existing trust records", async () => {
    const previous = {
      acceptedBy: "future-testkit",
      hash: "a".repeat(64),
      path: "/previous/.aura/preset.json",
    };
    const manifest = JSON.stringify({
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
      trustedRepoPresets: [previous],
    });
    await using seed = await createSeedBuilder()
      .homeFile("agents/aura.json", manifest)
      .workspaceFile(".aura/preset.json", '{"schemaVersion":1}\n')
      .trustWorkspacePreset()
      .build();

    const path = join(seed.homeDir, "agents", "aura.json");
    const state = parseAuraManifest(await readFile(path, "utf8"), path);

    expect(state.status).toBe("ready");
    if (state.status !== "ready") {
      return;
    }
    expect(state.value.trustedRepoPresets).toEqual([
      previous,
      {
        hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        path: join(seed.workspaceDir, ".aura", "preset.json"),
      },
    ]);
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
    // Pointed at a private temporary root on purpose. The claim is "this build left nothing behind",
    // and reading the shared one would also see seeds other test files are holding open, which
    // reports a leak or not depending on which worker happened to be mid-run.
    await using tempRoot = await createPrivateTempRoot();
    const build = createSeedBuilder()
      .homeFile("blocked", "file\n")
      .homeFile("blocked/nested", "cannot be written\n")
      .build();

    await expect(build).rejects.toBeDefined();

    await expect(readdir(tempRoot.path)).resolves.toEqual([]);
  });
});

interface PrivateTempRoot extends AsyncDisposable {
  readonly path: string;
}

/** Redirects `os.tmpdir()`, which is what the seed builder resolves its root against. */
async function createPrivateTempRoot(): Promise<PrivateTempRoot> {
  const previous = process.env["TMPDIR"];
  const path = await mkdtemp(join(tmpdir(), "aura-leakcheck-"));
  process.env["TMPDIR"] = path;

  return {
    path,
    [Symbol.asyncDispose]: async () => {
      if (previous === undefined) {
        delete process.env["TMPDIR"];
      } else {
        process.env["TMPDIR"] = previous;
      }
      await rm(path, { force: true, recursive: true });
    },
  };
}

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
