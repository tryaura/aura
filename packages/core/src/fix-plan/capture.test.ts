import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureBefore, type RetentionBudget } from "./capture.js";
import type { ValidatedOperation } from "./path-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("captureBefore", () => {
  it("captures a small file while the plan budget has room", async () => {
    const path = await createFile("small.json", "{}");

    const result = await captureBefore(operationAt(path, 3), path, budget(1_000), "written over");

    expect("state" in result && result.state.kind).toBe("file");
  });

  it("blames the exhausted plan budget rather than the file when the budget is spent", async () => {
    const path = await createFile("small.json", "{}");

    const result = await captureBefore(operationAt(path, 3), path, budget(0), "written over");

    // A two-byte file is not "too large"; what ran out is the plan-wide rollback capture budget.
    expect("conflict" in result ? result.conflict : "").toBe(
      "file is 2 bytes but the plan has only 0 bytes of rollback capture left, so it cannot be written over: Aura only changes a file whose previous contents it captured, so the change stays reversible. Apply this plan in smaller pieces",
    );
  });
});

async function createFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aura-capture-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content, "utf8");
  return path;
}

function operationAt(path: string, index: number): ValidatedOperation {
  return {
    index,
    operation: { content: "", path, type: "write" },
    paths: [path],
  };
}

function budget(remaining: number): RetentionBudget {
  return { remaining };
}
