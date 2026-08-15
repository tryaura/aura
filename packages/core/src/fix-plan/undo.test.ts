import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FixPlan } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { executeFixPlan, FixPlanUndoError, undoLastFixPlan } from "../index.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("durable fix-plan undo", () => {
  it("restores a mixed plan from its on-disk journal", async () => {
    const fixture = await createFixture();
    const updated = join(fixture.workspace, "updated.md");
    const removed = join(fixture.workspace, "removed.md");
    const source = join(fixture.workspace, "source.md");
    const destination = join(fixture.workspace, "archive", "source.md");
    const link = join(fixture.workspace, "nested", "instructions.md");
    const target = join(fixture.home, "agents", "AGENTS.md");
    await mkdir(join(fixture.home, "agents"), { recursive: true });
    await writeFile(target, "shared\n", "utf8");
    await writeFile(updated, "before\n", "utf8");
    await chmod(updated, 0o600);
    await writeFile(removed, "remove\n", "utf8");
    await writeFile(source, "move\n", "utf8");

    const plan: FixPlan = {
      operations: [
        { content: "after\n", path: updated, type: "write" },
        { path: removed, type: "remove" },
        { destinationPath: destination, sourcePath: source, type: "move" },
        { path: link, target, type: "symlink" },
      ],
      summary: "Exercise durable undo.",
    };
    const result = await executeFixPlan({ model: fixture.model, now, plan });

    expect(result.backupId).toBe("2026-08-15T00-00-00-000Z");
    const undone = await undoLastFixPlan({ homeDir: fixture.home, now });

    expect(undone).toMatchObject({ restoredOperationCount: 4, status: "undone" });
    await expect(readFile(updated, "utf8")).resolves.toBe("before\n");
    expect((await lstat(updated)).mode & 0o777).toBe(0o600);
    await expect(readFile(removed, "utf8")).resolves.toBe("remove\n");
    await expect(readFile(source, "utf8")).resolves.toBe("move\n");
    await expect(lstat(destination)).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(link)).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(join(fixture.workspace, "nested"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(readlink(link)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("walks backward through successful plans with timestamp collisions", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "zero\n", "utf8");

    const first = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writePlan(path, "one\n"),
    });
    const second = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writePlan(path, "two\n"),
    });

    expect(first.backupId).toBe("2026-08-15T00-00-00-000Z");
    expect(second.backupId).toBe("2026-08-15T00-00-00-000Z-0001");
    await undoLastFixPlan({ homeDir: fixture.home, now });
    await expect(readFile(path, "utf8")).resolves.toBe("one\n");
    await undoLastFixPlan({ homeDir: fixture.home, now });
    await expect(readFile(path, "utf8")).resolves.toBe("zero\n");
    await expect(undoLastFixPlan({ homeDir: fixture.home, now })).resolves.toEqual({
      status: "nothing-to-undo",
    });
  });

  it("refuses the complete undo when any path changed after application", async () => {
    const fixture = await createFixture();
    const first = join(fixture.workspace, "first.md");
    const second = join(fixture.workspace, "second.md");
    await writeFile(first, "before first\n", "utf8");
    await writeFile(second, "before second\n", "utf8");
    await executeFixPlan({
      model: fixture.model,
      now,
      plan: {
        operations: [
          { content: "after first\n", path: first, type: "write" },
          { content: "after second\n", path: second, type: "write" },
        ],
        summary: "Create an undo conflict.",
      },
    });
    await writeFile(second, "user edit\n", "utf8");

    await expect(undoLastFixPlan({ homeDir: fixture.home, now })).rejects.toMatchObject({
      code: "undo-conflict",
      rollback: "not-required",
    });
    await expect(readFile(first, "utf8")).resolves.toBe("after first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("user edit\n");
  });

  it("does not journal no-op or dry-run plans", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "same\n", "utf8");

    const noop = await executeFixPlan({ model: fixture.model, now, plan: writePlan(path, "same\n") });
    const dryRun = await executeFixPlan({
      dryRun: true,
      model: fixture.model,
      plan: writePlan(path, "different\n"),
    });

    expect(noop.backupId).toBeUndefined();
    expect(dryRun.backupId).toBeUndefined();
    await expect(undoLastFixPlan({ homeDir: fixture.home, now })).resolves.toEqual({
      status: "nothing-to-undo",
    });
  });

  it("reserves the backup store from plugin-authored plans", async () => {
    const fixture = await createFixture();
    await expect(
      executeFixPlan({
        model: fixture.model,
        now,
        plan: writePlan(join(fixture.home, "agents", ".backups", "journal.json"), "bad\n"),
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("exports the typed undo failure", () => {
    expect(FixPlanUndoError.prototype).toBeInstanceOf(Error);
  });
});

function writePlan(path: string, content: string): FixPlan {
  return {
    operations: [{ content, path, type: "write" }],
    summary: `Write ${path}.`,
  };
}

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
