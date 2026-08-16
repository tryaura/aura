import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { FixPlan } from "@tryaura/aura-sdk";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  applyFixPlan,
  executeFixPlan,
  type FixPlanApplyOptions,
  type FixOperationEffect,
  type FixOperationPreview,
  type FixPlanErrorCode,
  type FixPlanExecutionOptions,
  type FixPlanExecutionResult,
  type FixPlanPreview,
  type FixPlanPreviewOptions,
  prepareFixPlan,
  type PreparedFixPlan,
  previewFixPlan,
} from "../index.js";
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

describe("fix-plan execution", () => {
  it("exports the typed preview and execution contract", () => {
    expectTypeOf<
      "archive" | "conflict" | "create" | "noop" | "update"
    >().toMatchTypeOf<FixOperationEffect>();
    expectTypeOf<FixOperationPreview["diff"]>().toEqualTypeOf<string>();
    expectTypeOf<"invalid-path" | "path-conflict">().toMatchTypeOf<FixPlanErrorCode>();
    expectTypeOf<FixPlanPreviewOptions["plan"]>().toEqualTypeOf<FixPlan>();
    expectTypeOf<FixPlanExecutionOptions["dryRun"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<FixPlanApplyOptions["now"]>().toEqualTypeOf<() => Date>();
    expectTypeOf(previewFixPlan).returns.resolves.toEqualTypeOf<FixPlanPreview>();
    expectTypeOf(executeFixPlan).returns.resolves.toEqualTypeOf<FixPlanExecutionResult>();
    expectTypeOf(prepareFixPlan).returns.resolves.toEqualTypeOf<PreparedFixPlan>();
    expectTypeOf(applyFixPlan).returns.resolves.toEqualTypeOf<FixPlanExecutionResult>();
    expectTypeOf<PreparedFixPlan["preview"]>().toEqualTypeOf<FixPlanPreview>();
  });

  it("previews and applies every operation through one deterministic result", async () => {
    const fixture = await createFixture();
    const shared = join(fixture.home, "agents", "AGENTS.md");
    const stale = join(fixture.workspace, "stale.md");
    const legacy = join(fixture.workspace, "legacy.md");
    const archive = join(fixture.workspace, "archive", "legacy.md");
    const link = join(fixture.workspace, "AGENTS.md");
    await mkdir(join(fixture.home, "agents"), { recursive: true });
    await writeFile(shared, "# old\n", "utf8");
    await chmod(shared, 0o600);
    await writeFile(stale, "remove me\n", "utf8");
    await writeFile(legacy, "legacy\n", "utf8");

    const plan: FixPlan = {
      manualSteps: ["Review the generated instructions."],
      operations: [
        { content: "# shared\n", mode: 0o644, path: shared, type: "write" },
        { path: stale, type: "remove" },
        { destinationPath: archive, sourcePath: legacy, type: "move" },
        { path: link, target: shared, type: "symlink" },
      ],
      summary: "Normalize shared instructions.",
    };

    const firstPreview = await previewFixPlan({ model: fixture.model, plan });
    const secondPreview = await previewFixPlan({ model: fixture.model, plan });

    expect(secondPreview).toEqual(firstPreview);
    expect(firstPreview.changedOperationCount).toBe(4);
    expect(firstPreview.operations.map((operation) => operation.effect)).toEqual([
      "update",
      "remove",
      "move",
      "symlink",
    ]);
    expect(firstPreview.operations[0]?.diff).toContain("-# old");
    expect(firstPreview.operations[0]?.diff).toContain("+# shared");
    expect(firstPreview.operations[2]?.diff).toContain(`rename to ${archive}`);
    expect(firstPreview.operations[3]?.diff).toContain(`link target ${shared}`);

    const result = await executeFixPlan({ model: fixture.model, now, plan });

    expect(result.appliedOperationCount).toBe(4);
    expect(result.dryRun).toBe(false);
    await expect(readFile(shared, "utf8")).resolves.toBe("# shared\n");
    expect((await lstat(shared)).mode & 0o777).toBe(0o600);
    await expect(readFile(archive, "utf8")).resolves.toBe("legacy\n");
    await expect(readlink(link)).resolves.toBe(shared);
    await expect(lstat(stale)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("is idempotent without touching the filesystem on the second execution", async () => {
    const fixture = await createFixture();
    const shared = join(fixture.home, "agents", "AGENTS.md");
    const source = join(fixture.workspace, "legacy.md");
    const destination = join(fixture.workspace, "archive", "legacy.md");
    const stale = join(fixture.workspace, "stale.md");
    const link = join(fixture.workspace, "AGENTS.md");
    await mkdir(join(fixture.home, "agents"), { recursive: true });
    await writeFile(source, "legacy\n", "utf8");
    await writeFile(stale, "stale\n", "utf8");

    const plan: FixPlan = {
      operations: [
        { content: "# shared\n", path: shared, type: "write" },
        { path: stale, type: "remove" },
        { destinationPath: destination, sourcePath: source, type: "move" },
        { path: link, target: shared, type: "symlink" },
      ],
      summary: "Apply an idempotent fixture.",
    };

    const first = await executeFixPlan({ model: fixture.model, now, plan });
    const afterFirst = await snapshotFixture(fixture.root);
    const second = await executeFixPlan({ model: fixture.model, now, plan });
    const afterSecond = await snapshotFixture(fixture.root);

    expect(first.appliedOperationCount).toBe(4);
    expect(second.appliedOperationCount).toBe(0);
    expect(second.preview.changedOperationCount).toBe(0);
    expect(second.preview.operations.every((operation) => operation.effect === "noop")).toBe(true);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("keeps the complete filesystem byte-for-byte unchanged during a dry run", async () => {
    const fixture = await createFixture();
    const source = join(fixture.workspace, "source.md");
    const stale = join(fixture.workspace, "stale.md");
    await writeFile(source, "source\n", "utf8");
    await writeFile(stale, "stale\n", "utf8");

    const plan: FixPlan = {
      operations: [
        {
          content: "new\n",
          path: join(fixture.home, "agents", "nested", "new.md"),
          type: "write",
        },
        { path: stale, type: "remove" },
        {
          destinationPath: join(fixture.workspace, "new", "destination.md"),
          sourcePath: source,
          type: "move",
        },
        {
          path: join(fixture.workspace, "links", "AGENTS.md"),
          target: join(fixture.home, "agents", "nested", "new.md"),
          type: "symlink",
        },
      ],
      summary: "Preview without writes.",
    };
    const before = await snapshotFixture(fixture.root);

    const result = await executeFixPlan({ dryRun: true, model: fixture.model, now, plan });

    expect(result).toMatchObject({ appliedOperationCount: 0, dryRun: true });
    expect(result.preview.changedOperationCount).toBe(4);
    expect(await snapshotFixture(fixture.root)).toEqual(before);
    await expect(lstat(join(fixture.home, "agents"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(join(fixture.workspace, "new"))).rejects.toHaveProperty("code", "ENOENT");
  });
});

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}

interface SnapshotEntry {
  readonly content?: string | undefined;
  readonly modifiedTimeMs: number;
  readonly mode: number;
  readonly path: string;
  readonly target?: string | undefined;
  readonly type: "directory" | "file" | "symlink";
}

async function snapshotFixture(root: string): Promise<readonly SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  await snapshotDirectory(root, root, entries);
  return entries;
}

async function snapshotDirectory(
  root: string,
  directory: string,
  entries: SnapshotEntry[],
): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stats = await lstat(path);
    const common = {
      modifiedTimeMs: stats.mtimeMs,
      mode: stats.mode & 0o777,
      path: relative(root, path),
    };

    if (stats.isSymbolicLink()) {
      entries.push({ ...common, target: await readlink(path), type: "symlink" });
    } else if (stats.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      await snapshotDirectory(root, path, entries);
    } else {
      entries.push({ ...common, content: (await readFile(path)).toString("hex"), type: "file" });
    }
  }
}
