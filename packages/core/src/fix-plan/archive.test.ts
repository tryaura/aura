import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeFixPlan, previewFixPlan, undoFixPlan } from "../index.js";
import { backupEntryPath, createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fix-plan archives", () => {
  it("rejects unsafe journal-relative archive paths", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "CLAUDE.md");
    await writeFile(path, "original\n", "utf8");

    const preview = await previewFixPlan({
      model: fixture.model,
      plan: {
        operations: [{ path, relativePath: "../escape.md", type: "archive" }],
        summary: "Archive instructions.",
      },
    });

    expect(preview.operations[0]).toMatchObject({
      conflict: "archive relativePath must be a non-empty relative path without traversal",
      effect: "conflict",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("original\n");
  });

  it("stores exact originals and restores them through undo", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "CLAUDE.md");
    await writeFile(path, "original\r\nbytes\r\n", "utf8");
    await chmod(path, 0o600);

    const result = await executeFixPlan({
      model: fixture.model,
      now,
      plan: {
        operations: [
          {
            path,
            relativePath: "project/CLAUDE.md",
            replacement: { content: "@./AGENTS.md\n", mode: 0o644, type: "write" },
            type: "archive",
          },
        ],
        summary: "Consolidate instructions.",
      },
    });
    const archived = join(
      backupEntryPath(fixture, result.backupId),
      "consolidation",
      "project",
      "CLAUDE.md",
    );

    await expect(readFile(archived, "utf8")).resolves.toBe("original\r\nbytes\r\n");
    await expect(readFile(path, "utf8")).resolves.toBe("@./AGENTS.md\n");
    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toMatchObject({
      restoredOperationCount: 1,
      status: "undone",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("original\r\nbytes\r\n");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
});

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
