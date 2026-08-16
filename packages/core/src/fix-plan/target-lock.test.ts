import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { globalTargetPaths, withTargetLocks } from "./target-lock.js";

const temporaryDirectories: string[] = [];
const now = (): Date => new Date("2026-08-15T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("globalTargetPaths", () => {
  const project = join(sep, "repo");

  it("keeps home-scope targets and drops project-scoped ones", () => {
    expect(
      globalTargetPaths(
        [join(sep, "home", ".claude.json"), join(project, "CLAUDE.md"), project],
        project,
        false,
      ),
    ).toEqual([join(sep, "home", ".claude.json")]);
  });

  it("does not treat a dot-prefixed sibling of the project as project-scoped", () => {
    const sibling = `${project}.backup`;
    expect(globalTargetPaths([sibling], project, false)).toEqual([sibling]);
  });

  it("deduplicates targets that differ only by case on a case-insensitive filesystem", () => {
    const paths = [join(sep, "home", "Config.json"), join(sep, "home", "config.json")];
    expect(globalTargetPaths(paths, project, true)).toHaveLength(1);
    expect(globalTargetPaths(paths, project, false)).toHaveLength(2);
  });

  it("orders targets deterministically for deadlock-free acquisition", () => {
    const first = join(sep, "home", "a.json");
    const second = join(sep, "home", "b.json");
    expect(globalTargetPaths([second, first], project, false)).toEqual([first, second]);
  });
});

describe("withTargetLocks", () => {
  it("takes no lock when there is nothing global to protect", async () => {
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

    // Both lock directories exist but hold no records, so a second run acquires immediately.
    let entered = false;
    await withTargetLocks(targets, root, now, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aura-target-lock-"));
  temporaryDirectories.push(root);
  return root;
}
