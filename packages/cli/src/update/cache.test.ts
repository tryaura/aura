import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  attemptsFor,
  readUpdateCache,
  shouldCheck,
  writeUpdateCache,
  type UpdateCacheEntry,
} from "./cache.js";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
const IDENTITY = "github-release|https://api.github.com|acme|acme-cli|acme";

describe("update metadata cache", () => {
  it("round-trips an entry under a private, hashed path", async () => {
    const homeDir = await scratch();
    await writeUpdateCache(homeDir, IDENTITY, { checkedAt: NOW, etag: '"e1"', outcome: "current" });

    expect(await readUpdateCache(homeDir, IDENTITY, NOW)).toEqual({
      checkedAt: NOW,
      etag: '"e1"',
      outcome: "current",
    });
    const directory = join(homeDir, "agents", ".cache", "distribution-updates");
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{64}$/u);
    // The identity is hashed, so a repository name never lands in a path an unrelated tool lists.
    expect(names[0]).not.toContain("acme");
    expect(await readFile(join(directory, names[0] ?? ""), "utf8")).not.toContain(IDENTITY);
  });

  it("misses when the source identity changed", async () => {
    const homeDir = await scratch();
    await writeUpdateCache(homeDir, IDENTITY, { checkedAt: NOW, outcome: "current" });
    expect(await readUpdateCache(homeDir, "another-identity", NOW)).toBeUndefined();
  });

  it.each([
    { body: "{ not json", label: "an unparseable body" },
    { body: JSON.stringify({ checkedAt: NOW, identity: IDENTITY }), label: "no outcome" },
    {
      body: JSON.stringify({ checkedAt: NOW, identity: IDENTITY, outcome: "installed" }),
      label: "an outcome it does not know",
    },
    {
      body: JSON.stringify({ checkedAt: NOW + HOUR, identity: IDENTITY, outcome: "current" }),
      label: "a timestamp from the future",
    },
    {
      body: JSON.stringify({ checkedAt: NOW, identity: IDENTITY, outcome: "candidate" }),
      label: "a legacy candidate entry",
    },
    {
      body: JSON.stringify({
        candidate: { archive: { downloadUrl: "x", sha256: "short", size: 1 }, version: "1.4.0" },
        checkedAt: NOW,
        identity: IDENTITY,
        outcome: "candidate",
      }),
      label: "a legacy full candidate",
    },
  ])("treats $label as a miss", async ({ body }) => {
    const homeDir = await scratch();
    await writeUpdateCache(homeDir, IDENTITY, { checkedAt: NOW, outcome: "current" });
    const directory = join(homeDir, "agents", ".cache", "distribution-updates");
    const [name] = await readdir(directory);
    await writeFile(join(directory, name ?? ""), body, "utf8");

    expect(await readUpdateCache(homeDir, IDENTITY, NOW)).toBeUndefined();
  });

  it("never writes a credential into the entry", async () => {
    const homeDir = await scratch();
    await writeUpdateCache(homeDir, IDENTITY, {
      checkedAt: NOW,
      failedAttempts: 1,
      failedVersion: "1.4.0",
      outcome: "install-failed",
    });
    const directory = join(homeDir, "agents", ".cache", "distribution-updates");
    const [name] = await readdir(directory);
    expect(await readFile(join(directory, name ?? ""), "utf8")).not.toContain("Bearer");
  });
});

describe("update check cadence", () => {
  it("checks when nothing has been cached", () => {
    expect(shouldCheck(undefined, NOW)).toBe(true);
  });

  it.each([
    { elapsed: 0, expected: false, label: "a check from a moment ago", outcome: "current" },
    { elapsed: 23 * HOUR, expected: false, label: "a check from today", outcome: "current" },
    { elapsed: 25 * HOUR, expected: true, label: "a check from yesterday", outcome: "current" },
    {
      elapsed: 30 * 60 * 1_000,
      expected: false,
      label: "a recent failure",
      outcome: "check-failed",
    },
    { elapsed: 2 * HOUR, expected: true, label: "an hour-old failure", outcome: "check-failed" },
  ])("$label re-checks: $expected", ({ elapsed, expected, outcome }) => {
    const entry: UpdateCacheEntry = {
      checkedAt: NOW - elapsed,
      outcome: outcome === "current" ? "current" : "check-failed",
    };
    expect(shouldCheck(entry, NOW)).toBe(expected);
  });

  /**
   * A machine that cannot write to its own install directory would otherwise retry on every
   * command. The backoff doubles per attempt against the same version, and starts over when a
   * different release comes along.
   */
  it.each([
    { attempts: 1, elapsed: 10 * 60 * 1_000, expected: false },
    { attempts: 1, elapsed: 20 * 60 * 1_000, expected: true },
    { attempts: 3, elapsed: 50 * 60 * 1_000, expected: false },
    { attempts: 3, elapsed: 2 * HOUR, expected: true },
    { attempts: 20, elapsed: 23 * HOUR, expected: false },
    { attempts: 20, elapsed: 25 * HOUR, expected: true },
  ])(
    "backs off attempt $attempts for $elapsed ms: $expected",
    ({ attempts, elapsed, expected }) => {
      const entry: UpdateCacheEntry = {
        checkedAt: NOW - elapsed,
        failedAttempts: attempts,
        failedVersion: "1.4.0",
        outcome: "install-failed",
      };
      expect(shouldCheck(entry, NOW)).toBe(expected);
    },
  );

  it("counts attempts per candidate version and resets for a different release", () => {
    const entry: UpdateCacheEntry = {
      checkedAt: NOW,
      failedAttempts: 3,
      failedVersion: "1.4.0",
      outcome: "install-failed",
    };
    expect(attemptsFor(entry, "1.4.0")).toBe(3);
    expect(attemptsFor(entry, "1.5.0")).toBe(0);
    expect(attemptsFor(undefined, "1.4.0")).toBe(0);
  });
});

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "aura-update-cache-"));
}
