import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  applyFixPlan,
  executeFixPlan,
  FixPlanApplyError,
  type FixPlanRollbackStatus,
  prepareFixPlan,
  previewFixPlan,
} from "../index.js";
import { createFixPlanFixture, type FixPlanFixture } from "./testing.js";

const temporaryDirectories: string[] = [];
const restoreModes: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(restoreModes.splice(0).map((path) => chmod(path, 0o700)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("fix-plan application", () => {
  it("exports the typed failure contract", () => {
    expectTypeOf<FixPlanApplyError["rollback"]>().toEqualTypeOf<FixPlanRollbackStatus>();
    expectTypeOf<FixPlanApplyError["appliedOperationCount"]>().toEqualTypeOf<number>();
    expectTypeOf<FixPlanApplyError["rollbackFailures"]>().toEqualTypeOf<readonly string[]>();
  });

  it("replaces a symbolic link rather than writing through it", async () => {
    const fixture = await createFixture();
    const real = join(fixture.workspace, "real.md");
    const link = join(fixture.workspace, "link.md");
    await writeFile(real, "original\n", "utf8");
    await symlink(real, link);

    await executeFixPlan({
      model: fixture.model,
      now,
      plan: {
        operations: [{ content: "replaced\n", path: link, type: "write" }],
        summary: "Write at a linked path.",
      },
    });

    expect((await lstat(link)).isSymbolicLink()).toBe(false);
    await expect(readFile(link, "utf8")).resolves.toBe("replaced\n");
    await expect(readFile(real, "utf8")).resolves.toBe("original\n");
  });

  it("rolls back every applied operation when a later one fails", async () => {
    const fixture = await createFixture();
    const created = join(fixture.workspace, "fresh", "created.md");
    const updated = join(fixture.workspace, "updated.md");
    const drifting = join(fixture.workspace, "drifting.md");
    await writeFile(updated, "original\n", "utf8");
    await chmod(updated, 0o600);
    await writeFile(drifting, "stable\n", "utf8");

    const prepared = await prepareFixPlan({
      model: fixture.model,
      plan: {
        operations: [
          { content: "created\n", path: created, type: "write" },
          { content: "rewritten\n", path: updated, type: "write" },
          { content: "never applied\n", path: drifting, type: "write" },
        ],
        summary: "Fail on the last operation.",
      },
    });

    // Something else edits the third path between preview and apply.
    await writeFile(drifting, "changed underneath\n", "utf8");

    const failure = await applyFixPlan(prepared, { now }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FixPlanApplyError);
    expect(failure).toMatchObject({
      appliedOperationCount: 0,
      code: "filesystem-changed",
      operationIndex: 2,
      rollback: "complete",
      rollbackFailures: [],
    });
    await expect(readFile(updated, "utf8")).resolves.toBe("original\n");
    expect((await lstat(updated)).mode & 0o777).toBe(0o600);
    await expect(readFile(drifting, "utf8")).resolves.toBe("changed underneath\n");
    // The directory the first operation had to create is removed with it.
    await expect(lstat(join(fixture.workspace, "fresh"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rolls back a move and a removal, not just writes", async () => {
    const fixture = await createFixture();
    const source = join(fixture.workspace, "source.md");
    const destination = join(fixture.workspace, "archive", "source.md");
    const doomed = join(fixture.workspace, "doomed.md");
    const drifting = join(fixture.workspace, "drifting.md");
    await writeFile(source, "source\n", "utf8");
    await writeFile(doomed, "doomed\n", "utf8");
    await chmod(doomed, 0o600);
    await writeFile(drifting, "stable\n", "utf8");

    const prepared = await prepareFixPlan({
      model: fixture.model,
      plan: {
        operations: [
          { destinationPath: destination, sourcePath: source, type: "move" },
          { path: doomed, type: "remove" },
          { content: "never applied\n", path: drifting, type: "write" },
        ],
        summary: "Fail after a move and a removal.",
      },
    });
    await writeFile(drifting, "changed underneath\n", "utf8");

    await expect(applyFixPlan(prepared, { now })).rejects.toMatchObject({ rollback: "complete" });

    await expect(readFile(source, "utf8")).resolves.toBe("source\n");
    await expect(lstat(destination)).rejects.toHaveProperty("code", "ENOENT");
    await expect(readFile(doomed, "utf8")).resolves.toBe("doomed\n");
    expect((await lstat(doomed)).mode & 0o777).toBe(0o600);
  });

  it("applies exactly what a prepared plan previewed", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");

    const prepared = await prepareFixPlan({
      model: fixture.model,
      plan: {
        operations: [{ content: "config\n", path, type: "write" }],
        summary: "Prepare then apply.",
      },
    });
    const result = await applyFixPlan(prepared, { now });

    expect(result.preview).toBe(prepared.preview);
    expect(result.appliedOperationCount).toBe(1);
    await expect(readFile(path, "utf8")).resolves.toBe("config\n");
  });

  it("reports a requested mode the existing file will keep instead of applying it", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "old\n", "utf8");
    await chmod(path, 0o600);

    const preview = await previewFixPlan({
      model: fixture.model,
      plan: {
        operations: [{ content: "new\n", mode: 0o644, path, type: "write" }],
        summary: "Ask for a mode the file already has an opinion about.",
      },
    });

    expect(preview.operations[0]?.diff).toContain("mode 0o644 requested; existing mode 0o600");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "carries the underlying errno code so a caller can tell failures apart",
    async () => {
      const fixture = await createFixture();
      const opaque = join(fixture.workspace, "opaque");
      await mkdir(join(opaque, "inner"), { recursive: true });
      await chmod(opaque, 0o000);
      restoreModes.push(opaque);

      const failure = await previewFixPlan({
        model: fixture.model,
        plan: {
          operations: [{ content: "x\n", path: join(opaque, "inner", "config.md"), type: "write" }],
          summary: "Unreadable ancestor.",
        },
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "filesystem-error", systemErrorCode: "EACCES" });
      expect(failure).toHaveProperty("cause");
    },
  );
});

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}
