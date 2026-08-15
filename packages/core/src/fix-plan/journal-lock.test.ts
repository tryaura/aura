import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withJournalLock } from "./journal-lock.js";

const temporaryDirectories: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("journal lock", () => {
  it("publishes complete ownership before the lock becomes visible", async () => {
    const root = await createRoot();

    await withJournalLock(root, now, async () => {
      const entries = await lockEntries(root);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error("expected a published lock");
      }
      await expect(readFile(join(root, ".lock", entry), "utf8")).resolves.toContain(
        `"pid":${String(process.pid)}`,
      );
    });
  });

  it("never lets concurrent contenders overlap", async () => {
    const root = await createRoot();
    let active = 0;
    let maximumActive = 0;

    const run = async (): Promise<void> => {
      await withJournalLock(root, now, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    };
    await Promise.allSettled([run(), run()]);

    expect(maximumActive).toBeLessThanOrEqual(1);
  });

  it("keeps a recent unreadable contender instead of reaping it", async () => {
    const root = await createRoot();
    const directory = join(root, ".lock");
    await mkdir(directory);
    await writeFile(join(directory, "unreadable.json"), "", "utf8");

    await expect(
      withJournalLock(
        root,
        () => new Date(),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "backup-error" });
    await expect(readFile(join(directory, "unreadable.json"), "utf8")).resolves.toBe("");
  });

  it("keeps an old-format lock while its process is still alive", async () => {
    const root = await createRoot();
    const acquiredAt = new Date("2026-08-14T00:00:00.000Z");
    const path = join(root, ".lock");
    await writeFile(
      path,
      `${JSON.stringify({
        acquiredAt: acquiredAt.toISOString(),
        acquiredAtMs: acquiredAt.getTime(),
        pid: process.pid,
      })}\n`,
      "utf8",
    );

    await expect(withJournalLock(root, now, async () => undefined)).rejects.toMatchObject({
      code: "backup-error",
    });
    await expect(readFile(path, "utf8")).resolves.toContain(`"pid":${String(process.pid)}`);
  });

  it("does not release a lock whose ownership changed", async () => {
    const root = await createRoot();
    const directory = join(root, ".lock");

    await withJournalLock(root, now, async () => {
      const entries = await lockEntries(root);
      const entry = entries[0];
      if (entry === undefined) {
        throw new Error("expected a published lock");
      }
      await writeFile(
        join(directory, entry),
        `${JSON.stringify({
          acquiredAt: now().toISOString(),
          acquiredAtMs: now().getTime() + 1,
          ownerId: "replacement-owner",
          pid: process.pid,
        })}\n`,
        "utf8",
      );
    });

    await expect(lockEntries(root)).resolves.toHaveLength(1);
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aura-journal-lock-"));
  temporaryDirectories.push(root);
  return root;
}

async function lockEntries(root: string): Promise<readonly string[]> {
  return (await readdir(join(root, ".lock"))).filter((name) => name.endsWith(".json"));
}
