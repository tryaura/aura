import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

describe("targetPaths", () => {
  it("keeps both project and home targets", () => {
    const project = join(sep, "repo", "CLAUDE.md");
    const home = join(sep, "home", ".claude.json");
    expect(targetPaths([project, home], false)).toEqual([home, project].sort());
  });

  it("deduplicates syntactic aliases of one target", () => {
    const target = join(sep, "home", "config.json");
    const alias = `${join(sep, "home")}${sep}.${sep}config.json`;
    expect(targetPaths([target, alias], false)).toEqual([target]);
  });

  it("deduplicates targets that differ only by case on a case-insensitive filesystem", () => {
    const paths = [join(sep, "home", "Config.json"), join(sep, "home", "config.json")];
    expect(targetPaths(paths, true)).toHaveLength(1);
    expect(targetPaths(paths, false)).toHaveLength(2);
  });

  it("orders targets deterministically for deadlock-free acquisition", () => {
    const first = join(sep, "home", "a.json");
    const second = join(sep, "home", "b.json");
    expect(targetPaths([second, first], false)).toEqual([first, second]);
  });
});

describe("withTargetLocks", () => {
  it("takes no lock when there is no target to protect", async () => {
    const root = await createRoot();

    await withTargetLocks([], root, now, async () => undefined);

    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("serializes two runs that share a target", async () => {
    const root = await createRoot();
    const target = join(sep, "home", ".claude.json");
    let active = 0;
    let maximumActive = 0;

    const run = async (): Promise<void> => {
      await withTargetLocks([target], root, now, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });
    };
    await Promise.allSettled([run(), run()]);

    expect(maximumActive).toBeLessThanOrEqual(1);
  });

  it("names the contested file in the contention error", async () => {
    const root = await createRoot();
    const target = join(sep, "home", ".claude.json");

    await withTargetLocks([target], root, now, async () => {
      await expect(
        withTargetLocks(
          [target, join(sep, "home", "other.json")],
          root,
          now,
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code: "backup-error",
        message: expect.stringContaining(target),
      });
    });
  });

  it("releases every lock when the action throws", async () => {
    const root = await createRoot();
    const targets = [join(sep, "home", "a.json"), join(sep, "home", "b.json")];

    await expect(
      withTargetLocks(targets, root, now, async () => {
        throw new Error("apply failed");
      }),
    ).rejects.toThrow("apply failed");

    // Every lock was released, so a second run acquires immediately.
    let entered = false;
    await withTargetLocks(targets, root, now, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("removes emptied per-target lock directories instead of accumulating them", async () => {
    const root = await createRoot();
    const targets = [join(sep, "home", "a.json"), join(sep, "home", "b.json")];

    await withTargetLocks(targets, root, now, async () => undefined);

    await expect(readdir(join(root, ".target-locks"))).resolves.toEqual([]);
  });

  it("leaves a contender's directory alone when its record is still published", async () => {
    const root = await createRoot();
    const target = join(sep, "home", ".claude.json");

    await withTargetLocks([target], root, now, async () => {
      await expect(
        withTargetLocks([target], root, now, async () => undefined),
      ).rejects.toMatchObject({ code: "backup-error" });
      // The outer lock is still held: its record survived the inner run's cleanup attempt.
      const entries = await readdir(join(root, ".target-locks"));
      expect(entries).toHaveLength(1);
    });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aura-target-lock-"));
  temporaryDirectories.push(root);
  return root;
}
