import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ANY_ARGUMENT, createSeedBuilder } from "./index.js";

describe("shim invocation logs", () => {
  it("records parallel invocations without interleaving fields", async () => {
    await using seed = await createSeedBuilder()
      .shim("parallel-agent", [{ args: [ANY_ARGUMENT] }])
      .build();
    const expected = Array.from({ length: 96 }, (_, index) => [`invocation-${String(index)}`]);

    await Promise.all(expected.map((args) => runShim(join(seed.pathDir, "parallel-agent"), args)));

    const actual = await seed.invocations("parallel-agent");
    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expect.arrayContaining(expected));
  });

  it("keeps its versioned on-disk record format deliberate", async () => {
    await using seed = await createSeedBuilder()
      .shim("record-agent", [{ args: [ANY_ARGUMENT, ANY_ARGUMENT, ANY_ARGUMENT] }])
      .build();

    await runShim(join(seed.pathDir, "record-agent"), ["", "two\nlines", "💫"]);

    const log = await readFile(join(dirname(seed.homeDir), "invocations", "record-agent"), "utf8");
    expect(log).toMatchInlineSnapshot(`
      "aura-testkit-v1	3		dHdvCmxpbmVz	8J+Sqw==
      "
    `);
    await expect(seed.invocations("record-agent")).resolves.toEqual([["", "two\nlines", "💫"]]);
  });

  it("reports an oversized invocation as a distinct truncation error", async () => {
    await using seed = await createSeedBuilder()
      .shim("bounded-agent", [{ args: [ANY_ARGUMENT] }])
      .build();

    await runShim(join(seed.pathDir, "bounded-agent"), ["x".repeat(1_800)]);

    await expect(seed.invocations("bounded-agent")).rejects.toThrow(
      /produced a [0-9]+-byte log record, exceeding the 2048-byte atomic limit/u,
    );
  });
});

function runShim(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: { PATH: dirname(executable) },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`Shim exited with code ${String(exitCode)}.`));
      }
    });
  });
}
