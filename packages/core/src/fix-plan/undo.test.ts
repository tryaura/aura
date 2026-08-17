import { chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FixPlan } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  executeFixPlan,
  FixPlanUndoError,
  type FixPlanUndoOptions,
  type FixPlanUndoResult,
  undoFixPlan,
} from "../index.js";
import {
  backupManifestPath,
  createFixPlanFixture,
  writeFixPlan,
  type FixPlanFixture,
} from "./testing.js";
import { backupRoot } from "./journal-paths.js";
import { targetPaths, withTargetLocks } from "./target-lock.js";

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
    const undone = await undoFixPlan({ model: fixture.model, now });

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
      plan: writeFixPlan(path, "one\n"),
    });
    const second = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "two\n"),
    });

    expect(first.backupId).toBe("2026-08-15T00-00-00-000Z");
    expect(second.backupId).toBe("2026-08-15T00-00-00-000Z-0001");
    await undoFixPlan({ model: fixture.model, now });
    await expect(readFile(path, "utf8")).resolves.toBe("one\n");
    await undoFixPlan({ model: fixture.model, now });
    await expect(readFile(path, "utf8")).resolves.toBe("zero\n");
    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toEqual({
      status: "nothing-to-undo",
    });
  });

  it("removes shared parent directories only after their final restored child", async () => {
    const fixture = await createFixture();
    const root = join(fixture.workspace, "generated");
    await executeFixPlan({
      model: fixture.model,
      now,
      plan: {
        operations: [
          { content: "a\n", path: join(root, "a", "config.md"), type: "write" },
          { content: "b\n", path: join(root, "b", "config.md"), type: "write" },
        ],
        summary: "Create sibling trees.",
      },
    });

    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toMatchObject({
      restoredOperationCount: 2,
      status: "undone",
    });
    await expect(lstat(root)).rejects.toHaveProperty("code", "ENOENT");
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

    await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
      code: "undo-conflict",
      rollback: "not-required",
    });
    await expect(readFile(first, "utf8")).resolves.toBe("after first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("user edit\n");
  });

  it("refuses to race an undo against another run holding its target", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "after\n"),
    });
    const locks = [
      ...new Set([...targetPaths([path], false), ...targetPaths([path], true)]),
    ].sort();

    await withTargetLocks(locks, backupRoot(fixture.home), now, async () => {
      await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
        code: "backup-error",
      });
    });

    await expect(readFile(path, "utf8")).resolves.toBe("after\n");
  });

  it("attributes a preflight inspection failure to the operation being verified", async () => {
    const fixture = await createFixture();
    const first = join(fixture.workspace, "first.md");
    const nested = join(fixture.workspace, "nested");
    const second = join(nested, "second.md");
    const plan: FixPlan = {
      operations: [
        { content: "one\n", path: first, type: "write" },
        { content: "two\n", path: second, type: "write" },
      ],
      summary: "Two writes.",
    };
    await executeFixPlan({ model: fixture.model, now, plan });
    // Replace the second target's parent directory with a regular file, so inspecting the second
    // path fails with something other than "missing".
    await rm(nested, { recursive: true });
    await writeFile(nested, "not a directory\n", "utf8");

    await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
      code: "filesystem-error",
      message: expect.stringContaining("Fix operation 1"),
      operationIndex: 1,
    });
  });

  it("rolls restored paths forward when directory cleanup fails", async () => {
    const fixture = await createFixture();
    const directory = join(fixture.workspace, "generated");
    const path = join(directory, "config.md");
    await executeFixPlan({ model: fixture.model, now, plan: writeFixPlan(path, "generated\n") });
    await writeFile(join(directory, "user.md"), "user content\n", "utf8");

    await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
      code: "filesystem-error",
      rollback: "complete",
      rollbackFailures: [],
    });
    await expect(readFile(path, "utf8")).resolves.toBe("generated\n");
    await expect(readFile(join(directory, "user.md"), "utf8")).resolves.toBe("user content\n");
  });

  it("recovers an applied plan whose journal still says pending", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    const result = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "after\n"),
    });
    const manifest = backupManifestPath(fixture, result.backupId);
    const contents = await readFile(manifest, "utf8");
    await writeFile(manifest, contents.replace('"status": "applied"', '"status": "pending"'));

    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toMatchObject({
      restoredOperationCount: 1,
      status: "undone",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("before\n");
  });

  it("restores a directory mode without the bits a capture cannot produce", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    await chmod(path, 0o600);
    const result = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "after\n"),
    });
    const manifest = backupManifestPath(fixture, result.backupId);
    const tampered = (await readFile(manifest, "utf8")).replace(
      `"mode": ${String(0o600)}`,
      `"mode": ${String(0o4600)}`,
    );
    await writeFile(manifest, tampered, "utf8");

    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toMatchObject({
      status: "undone",
    });
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
  });

  it("refuses to restore outside the roots the plan recorded", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    const result = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "after\n"),
    });
    const manifest = backupManifestPath(fixture, result.backupId);
    const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(
      manifest,
      JSON.stringify({ ...(parsed as object), roots: [{ exact: true, path: "/nowhere" }] }),
      "utf8",
    );

    await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
      code: "undo-conflict",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("after\n");
  });

  it("exports the typed undo failure", () => {
    expect(FixPlanUndoError.prototype).toBeInstanceOf(Error);
    expectTypeOf<FixPlanUndoOptions["now"]>().toEqualTypeOf<() => Date>();
    expectTypeOf(undoFixPlan).returns.resolves.toEqualTypeOf<FixPlanUndoResult>();
  });
});

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
