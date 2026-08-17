import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  executeFixPlan,
  listFixPlanBackups,
  undoFixPlan,
  type FixPlanBackup,
  type FixPlanBackupListOptions,
  type FixPlanBackupStatus,
} from "../index.js";
import { backupRoot, MAX_JOURNAL_ENTRIES } from "./journal-paths.js";
import {
  backupEntryPath,
  backupManifestPath,
  createFixPlanFixture,
  writeFixPlan,
  type FixPlanFixture,
} from "./testing.js";

const temporaryDirectories: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("durable fix-plan backup store", () => {
  it("does not journal no-op or dry-run plans", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "same\n", "utf8");

    const noop = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "same\n"),
    });
    const dryRun = await executeFixPlan({
      dryRun: true,
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "different\n"),
    });

    expect(noop.backupId).toBeUndefined();
    expect(dryRun.backupId).toBeUndefined();
    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toEqual({
      status: "nothing-to-undo",
    });
  });

  it("keeps backup directories and payloads owner-only", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    const result = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "after\n"),
    });
    const entry = backupEntryPath(fixture, result.backupId);

    expect((await lstat(backupRoot(fixture.home))).mode & 0o777).toBe(0o700);
    expect((await lstat(entry)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(entry, "files"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(entry, "manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(entry, "files", "0-before.bin"))).mode & 0o777).toBe(0o600);
  });

  it("reserves the backup store from plugin-authored plans", async () => {
    const fixture = await createFixture();
    await expect(
      executeFixPlan({
        model: fixture.model,
        now,
        plan: writeFixPlan(join(backupRoot(fixture.home), "journal.json"), "bad\n"),
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("does not mutate targets when the backup store cannot be created", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    const agents = join(fixture.home, "agents");
    await mkdir(agents);
    await writeFile(join(agents, ".backups"), "not a directory\n", "utf8");
    await writeFile(path, "before\n", "utf8");

    await expect(
      executeFixPlan({ model: fixture.model, now, plan: writeFixPlan(path, "after\n") }),
    ).rejects.toMatchObject({ code: "backup-error" });
    await expect(readFile(path, "utf8")).resolves.toBe("before\n");
  });

  it("refuses a backup store reached through a symbolic link", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    const elsewhere = join(fixture.root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(join(fixture.home, "agents"));
    await symlink(elsewhere, backupRoot(fixture.home));
    await writeFile(path, "before\n", "utf8");

    await expect(
      executeFixPlan({ model: fixture.model, now, plan: writeFixPlan(path, "after\n") }),
    ).rejects.toMatchObject({ code: "backup-error" });
    await expect(readFile(path, "utf8")).resolves.toBe("before\n");
    await expect(readdir(elsewhere)).resolves.toEqual([]);
  });

  it("rejects a corrupt journal without touching the applied path", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    const result = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(path, "after\n"),
    });
    await writeFile(backupManifestPath(fixture, result.backupId), "{broken\n", "utf8");

    await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
      code: "journal-corrupt",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("after\n");
  });

  it("undoes past an unreadable entry rather than stopping at it", async () => {
    const fixture = await createFixture();
    const first = join(fixture.workspace, "first.md");
    const second = join(fixture.workspace, "second.md");
    await writeFile(first, "before first\n", "utf8");
    await writeFile(second, "before second\n", "utf8");
    const older = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(first, "after first\n"),
    });
    const newer = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(second, "after second\n"),
    });
    await rm(backupManifestPath(fixture, newer.backupId));

    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toMatchObject({
      backupId: older.backupId,
      skippedBackupIds: [newer.backupId],
      status: "undone",
    });
    await expect(readFile(first, "utf8")).resolves.toBe("before first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("after second\n");
  });

  it("undoes a named entry and lists what the store holds", async () => {
    const fixture = await createFixture();
    const first = join(fixture.workspace, "first.md");
    const second = join(fixture.workspace, "second.md");
    await writeFile(first, "before first\n", "utf8");
    await writeFile(second, "before second\n", "utf8");
    const older = await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(first, "after first\n"),
    });
    await executeFixPlan({
      model: fixture.model,
      now,
      plan: writeFixPlan(second, "after second\n"),
    });

    await expect(
      undoFixPlan({ backupId: older.backupId, model: fixture.model, now }),
    ).resolves.toMatchObject({ backupId: older.backupId, status: "undone" });
    await expect(readFile(first, "utf8")).resolves.toBe("before first\n");
    await expect(readFile(second, "utf8")).resolves.toBe("after second\n");

    await expect(listFixPlanBackups({ homeDir: fixture.model.homeDir })).resolves.toMatchObject([
      { operationCount: 1, status: "applied", undoable: true },
      { id: older.backupId, status: "undone", undoable: false },
    ]);
    await expect(
      undoFixPlan({ backupId: older.backupId, model: fixture.model, now }),
    ).rejects.toMatchObject({ code: "backup-error" });
    await expect(
      undoFixPlan({ backupId: "2020-01-01T00-00-00-000Z", model: fixture.model, now }),
    ).rejects.toMatchObject({ code: "backup-error" });
  });

  it("drops the oldest entries past the retention ceiling", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "0\n", "utf8");
    for (let revision = 1; revision <= MAX_JOURNAL_ENTRIES + 2; revision += 1) {
      await executeFixPlan({
        model: fixture.model,
        now,
        plan: writeFixPlan(path, `${String(revision)}\n`),
      });
    }

    const backups = await listFixPlanBackups({ homeDir: fixture.model.homeDir });
    expect(backups).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(backups.every((backup) => backup.status === "applied")).toBe(true);
    // The newest entry keeps the highest tiebreaker, so retention never files a new entry behind
    // the entries it follows.
    expect(backups[0]?.id).toBe(
      `2026-08-15T00-00-00-000Z-${String(MAX_JOURNAL_ENTRIES + 1).padStart(4, "0")}`,
    );
  });

  it("refuses to run while another run holds the journal", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    await executeFixPlan({ model: fixture.model, now, plan: writeFixPlan(path, "after\n") });
    await writeLock(fixture, {
      acquiredAt: now().toISOString(),
      acquiredAtMs: now().getTime(),
      ownerId: "active-owner",
      pid: process.pid,
    });

    await expect(undoFixPlan({ model: fixture.model, now })).rejects.toMatchObject({
      code: "backup-error",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("after\n");
  });

  it("takes over a lock its holder left behind", async () => {
    const fixture = await createFixture();
    const path = join(fixture.workspace, "config.md");
    await writeFile(path, "before\n", "utf8");
    await executeFixPlan({ model: fixture.model, now, plan: writeFixPlan(path, "after\n") });
    const acquiredAt = new Date("2026-08-14T00:00:00.000Z");
    await writeLock(fixture, {
      acquiredAt: acquiredAt.toISOString(),
      acquiredAtMs: acquiredAt.getTime(),
      ownerId: "stale-owner",
      pid: 2_147_483_647,
    });

    await expect(undoFixPlan({ model: fixture.model, now })).resolves.toMatchObject({
      status: "undone",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("before\n");
  });

  it("exports the typed backup listing", () => {
    expectTypeOf(listFixPlanBackups).returns.resolves.toEqualTypeOf<readonly FixPlanBackup[]>();
    expectTypeOf<FixPlanBackupListOptions["homeDir"]>().toEqualTypeOf<string>();
    expectTypeOf<FixPlanBackupStatus>().toEqualTypeOf<
      "aborted" | "applied" | "pending" | "undone" | "unreadable"
    >();
  });
});

async function createFixture(): Promise<FixPlanFixture> {
  const fixture = await createFixPlanFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}

async function writeLock(fixture: FixPlanFixture, owner: object): Promise<void> {
  const directory = join(backupRoot(fixture.home), ".lock");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "fixture.json"), `${JSON.stringify(owner)}\n`, "utf8");
}
