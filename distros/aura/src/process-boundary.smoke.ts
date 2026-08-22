import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSeedBuilder } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import { BINARY_PATH, runCompiled } from "./binary-test-support.js";

const execFileAsync = promisify(execFile);

describe("compiled Aura process boundary", () => {
  it("keeps real pipe output quiet, plain, and machine-parseable", async () => {
    await using seed = await createSeedBuilder().build();
    const args = ["check", "--home", seed.homeDir, "--path", seed.pathDir];

    const human = await runCompiled(seed, args);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).not.toContain("[");
    expect(human.stdout).toContain("Docs: https://tryaura.sh/docs/quickstart");
    expect(human.stderr).toBe("");

    const json = await runCompiled(seed, [...args, "--json"]);
    const document: unknown = JSON.parse(json.stdout);
    expect(json.stdout).toBe(`${JSON.stringify(document)}\n`);
    expect(json.stderr).toBe("");
  });

  /**
   * A reader closing the pipe must not rewrite the verdict.
   *
   * `aura check | head` is someone glancing at the top of a report, and `| grep -q` is a script
   * asking one question of it. Both close the pipe early, on a run that completed its checks and
   * so exits 0 whatever it found. The failure this pins is the write that lands after the reader
   * is gone: an unhandled EPIPE turns a finished run into an operational failure, and a script
   * that pipes the report would then fail on machines the same command clears when it does not.
   */
  it("keeps its exit code when a reader closes the pipe", async () => {
    await using seed = await createSeedBuilder().build();
    const statusFile = join(seed.workspaceDir, "aura-status");

    const piped = await execFileAsync(
      "/bin/sh",
      [
        "-c",
        '{ "$AURA_BINARY" check --home "$HOME" --path "$PATH"; echo "$?" > "$AURA_STATUS"; }' +
          " | /usr/bin/head -n 1",
      ],
      {
        cwd: seed.workspaceDir,
        encoding: "utf8",
        env: {
          AURA_BINARY: BINARY_PATH,
          AURA_STATUS: statusFile,
          HOME: seed.homeDir,
          PATH: seed.pathDir,
        },
      },
    );

    expect(piped.stdout).toMatch(/^Aura check — /);
    expect(piped.stderr).toBe("");
    expect((await readFile(statusFile, "utf8")).trim()).toBe("0");
  });
});
