import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acquireUpdateLock } from "./lock.js";
import type { UpdateHost } from "./host.js";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const STALE = NOW - 11 * 60 * 1_000;

describe("updater exclusion", () => {
  it("lets exactly one of two concurrent updaters through", async () => {
    const lockPath = await scratchLock();

    const first = await acquireUpdateLock({ host: host(), lockPath, now: NOW });
    const second = await acquireUpdateLock({ host: host(), lockPath, now: NOW });

    expect(first.kind).toBe("acquired");
    expect(second.kind).toBe("held");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({ pid: 4_242, startedAt: NOW });
  });

  it("lets the next updater in once the holder releases", async () => {
    const lockPath = await scratchLock();
    const first = await acquireUpdateLock({ host: host(), lockPath, now: NOW });
    await (first.kind === "acquired" ? first.lock.release() : Promise.resolve());

    expect((await acquireUpdateLock({ host: host(), lockPath, now: NOW })).kind).toBe("acquired");
  });

  it("waits on a fresh lock whatever its owner is doing", async () => {
    const lockPath = await scratchLock();
    await writeFile(lockPath, JSON.stringify({ pid: 9_001, startedAt: NOW - 1_000 }), "utf8");

    expect(
      (await acquireUpdateLock({ host: host({ alive: false }), lockPath, now: NOW })).kind,
    ).toBe("held");
  });

  /**
   * Age alone would break a slow but healthy download on a thin connection; a missing process
   * alone would race a holder that has not written its record yet. Both are required.
   */
  it("waits on an old lock whose owner is still running", async () => {
    const lockPath = await scratchLock();
    await writeFile(lockPath, JSON.stringify({ pid: 9_001, startedAt: STALE }), "utf8");

    expect(
      (await acquireUpdateLock({ host: host({ alive: true }), lockPath, now: NOW })).kind,
    ).toBe("held");
  });

  it("reclaims an old lock whose owner is gone", async () => {
    const lockPath = await scratchLock();
    await writeFile(lockPath, JSON.stringify({ pid: 9_001, startedAt: STALE }), "utf8");

    const lock = await acquireUpdateLock({ host: host({ alive: false }), lockPath, now: NOW });
    expect(lock.kind).toBe("acquired");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: 4_242 });
  });

  /**
   * An updater killed between creating the lock and writing its record leaves a file naming no
   * process. Falling back to the file's own age is what keeps that from wedging the machine.
   */
  it("reclaims an old lock that names no process", async () => {
    const lockPath = await scratchLock();
    await writeFile(lockPath, "", "utf8");
    const old = new Date(STALE);
    await utimes(lockPath, old, old);

    expect(
      (await acquireUpdateLock({ host: host({ alive: false }), lockPath, now: NOW })).kind,
    ).toBe("acquired");
  });

  it("leaves a recently written unreadable lock alone", async () => {
    const lockPath = await scratchLock();
    await writeFile(lockPath, "", "utf8");
    const recent = new Date(NOW - 1_000);
    await utimes(lockPath, recent, recent);

    expect(
      (await acquireUpdateLock({ host: host({ alive: false }), lockPath, now: NOW })).kind,
    ).toBe("held");
  });

  it("reports a directory it cannot write to as unavailable rather than held", async () => {
    const lockPath = join(
      await mkdtemp(join(tmpdir(), "aura-update-lock-")),
      "missing",
      "acme.lock",
    );

    expect((await acquireUpdateLock({ host: host(), lockPath, now: NOW })).kind).toBe(
      "unavailable",
    );
  });

  it("creates the lock readable only by its owner", async () => {
    const lockPath = await scratchLock();
    await acquireUpdateLock({ host: host(), lockPath, now: NOW });

    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });
});

function host(options: { readonly alive?: boolean | undefined } = {}): UpdateHost {
  return {
    download: () => Promise.resolve({ kind: "failure", reason: "network" }),
    isProcessAlive: () => options.alive ?? false,
    pid: 4_242,
    probeVersion: () => Promise.resolve(undefined),
  };
}

async function scratchLock(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "aura-update-lock-")), "acme.update-lock");
}
