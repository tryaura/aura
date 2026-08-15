import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createSeedBuilder, runBinaryCheck } from "@tryaura/aura-testkit";
import { describe, expect, it } from "vitest";

import packageManifest from "../package.json" with { type: "json" };

const BINARY_PATH = fileURLToPath(new URL("../dist/aura", import.meta.url));
const BUN_VERSION_FILE = new URL("../../../.bun-version", import.meta.url);
const execFileAsync = promisify(execFile);

/**
 * What the binary must report as its own version.
 *
 * A release stamps the tag into the manifest before compiling, and passes it back in here. Falling
 * back to the manifest is right for a local run and wrong for a release: the binary is compiled from
 * that same file, so a stamp that silently did nothing would still match itself.
 */
const EXPECTED_VERSION = process.env["AURA_EXPECTED_VERSION"] ?? packageManifest.version;

describe("compiled Aura distribution", () => {
  it("runs as Aura against an isolated testkit seed", async () => {
    await using seed = await createSeedBuilder()
      // A compiled Bun executable can load this before its entry point unless compilation disables
      // runtime dotenv loading. If it leaks in, BUN_BE_BUN turns the artifact into the Bun CLI.
      .workspaceFile(".env", "BUN_BE_BUN=1\n")
      .build();

    const version = await execFileAsync(BINARY_PATH, ["--version"], {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: { HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
    });
    expect(version).toEqual({
      stderr: "",
      stdout: `${EXPECTED_VERSION}\n`,
    });

    const result = await runBinaryCheck({ binaryPath: BINARY_PATH, seed });
    expect(result.report).toEqual({
      diagnostics: [],
      exitCode: 2,
      findings: [],
      passedChecks: [],
      skipped: [],
      status: "empty",
      summary: { errors: 0, informational: 0, passed: 0, warnings: 0 },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.diffs).toEqual([]);
  });

  /**
   * Records a property of the artifact rather than endorsing it.
   *
   * Compilation closes the route through a workspace `.env`, but the Bun runtime reads this variable
   * out of the ambient environment before any Aura code runs, and `bun build` offers no flag to
   * compile the behaviour out. Anyone who can set environment variables on an `aura` invocation can
   * therefore run arbitrary code through it. Pinned so that the day Bun offers a way to refuse, this
   * test fails and points at the fix instead of the property going unnoticed.
   */
  it("is still turned into the Bun CLI by an ambient BUN_BE_BUN", async () => {
    await using seed = await createSeedBuilder().build();
    const bunVersion = (await readFile(BUN_VERSION_FILE, "utf8")).trim();

    const { stdout } = await execFileAsync(BINARY_PATH, ["--version"], {
      cwd: seed.workspaceDir,
      encoding: "utf8",
      env: { BUN_BE_BUN: "1", HOME: seed.homeDir, NO_COLOR: "1", PATH: seed.pathDir },
    });

    expect(stdout.trim()).toBe(bunVersion);
  });
});
