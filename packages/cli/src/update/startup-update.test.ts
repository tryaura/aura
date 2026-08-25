import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { readUpdateCache } from "./cache.js";
import { STARTUP_UPDATE_BUDGET_MS } from "./limits.js";
import { runStartupUpdate, type StartupUpdateRequest } from "./run.js";
import { sourceIdentity } from "./provider.js";
import { BRANDING, IDENTITY, NOW, scenario } from "./testing.js";
import type { CliUpdates } from "./types.js";

describe("startup update", () => {
  it("invalidates cached metadata when signed-manifest trust changes", () => {
    const source: CliUpdates = {
      kind: "signed-manifest",
      manifestUrl: "https://releases.example/acme/latest.json?channel=stable",
      trustedPublicKeys: ["first-key"],
    };

    expect(sourceIdentity(source, BRANDING.command)).not.toBe(
      sourceIdentity({ ...source, trustedPublicKeys: ["next-key"] }, BRANDING.command),
    );
    expect(sourceIdentity(source, BRANDING.command)).not.toBe(
      sourceIdentity(
        { ...source, manifestUrl: "https://releases.example/acme/latest.json?channel=preview" },
        BRANDING.command,
      ),
    );
  });

  it("installs a newer release and says so in two lines on stderr", async () => {
    const run = await scenario();
    const outcome = await runStartupUpdate(run.request);

    expect(outcome).toEqual({ kind: "installed", version: "1.4.0" });
    expect(run.stderr()).toBe(
      "Updating Acme Doctor 1.3.0 -> 1.4.0...\n" +
        "Updated Acme Doctor to 1.4.0. The new version will be used on your next run.\n",
    );
    expect(run.stdout()).toBe("");
    expect(await readFile(run.executablePath, "utf8")).toBe("VERSION=1.4.0\n");
  });

  it("records the install so the next command does not check again within two hours", async () => {
    const run = await scenario();
    await runStartupUpdate(run.request);

    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toEqual({
      checkedAt: NOW.getTime(),
      outcome: "current",
    });

    await runStartupUpdate(run.request);
    expect(run.requests).toHaveLength(1);
  });

  it("bypasses a fresh cache entry when explicitly requested", async () => {
    const run = await scenario({ tag: "v1.3.0" });
    await runStartupUpdate(run.request);
    await runStartupUpdate({ ...run.request, bypassCache: true });

    expect(run.requests).toHaveLength(2);
  });

  /** Silence is right for the user and useless for whoever wired the distribution up. */
  it("names the gate that refused, and reaches no network", async () => {
    const run = await scenario({ environmentVariables: { ACME_UPDATE_DEBUG: "1" } });
    const outcome = await runStartupUpdate({
      ...run.request,
      current: { ...run.request.current, platform: "win32" },
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "unsupported-target" });
    expect(run.stderr()).toBe("update: skipped: unsupported-target\n");
    expect(run.requests).toEqual([]);
  });

  it("traces a whole run when tracing is on", async () => {
    const run = await scenario({ environmentVariables: { ACME_UPDATE_DEBUG: "1" } });
    await runStartupUpdate(run.request);

    expect(run.stderr()).toContain("update: resolved: candidate");
    expect(run.stderr()).toContain("update: installed: installed");
  });

  /**
   * The user gets one sentence whatever went wrong, which is right for them and useless for whoever
   * has to fix it. A transfer that never started and an archive the extractor refused are the same
   * silent nothing from the outside; the trace is the only place they are told apart.
   */
  it("names which step gave up when an install fails", async () => {
    const run = await scenario({ environmentVariables: { ACME_UPDATE_DEBUG: "1" } });
    await runStartupUpdate({
      ...run.request,
      host: {
        ...run.request.host,
        download: () => Promise.resolve({ kind: "failure", reason: "too-large" }),
      },
    });

    expect(run.stderr()).toContain("update: installed: failed: download-too-large");
  });

  /**
   * A per-step ceiling is not an aggregate one. The budget is anchored where the check began, so
   * whatever the metadata request and the probe of the installed binary spent is time the download
   * no longer has — otherwise every step finishing just inside its own limit is a command that has
   * not started yet.
   */
  it("gives the download only what is left of the startup budget", async () => {
    const spent = 90_000;
    const clock = [NOW, new Date(NOW.getTime() + spent)];
    const run = await scenario({ now: () => clock.shift() ?? new Date(NOW.getTime() + spent) });

    await runStartupUpdate(run.request);

    expect(run.downloads).toHaveLength(1);
    expect(run.downloads[0]?.timeoutMs).toBe(STARTUP_UPDATE_BUDGET_MS - spent);
  });

  it("says nothing when the release is the running one", async () => {
    const run = await scenario({ tag: "v1.3.0" });
    const outcome = await runStartupUpdate(run.request);

    expect(outcome).toEqual({ kind: "current" });
    expect(run.stderr()).toBe("");
    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toMatchObject({
      outcome: "current",
    });
  });

  /** The executable on disk is current, so anything but `current` asks for a pointless re-check. */
  it("records a release another updater installed as current", async () => {
    const run = await scenario();
    await writeFile(run.executablePath, "VERSION=1.4.0\n", { mode: 0o755 });
    await runStartupUpdate(run.request);

    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toEqual({
      checkedAt: NOW.getTime(),
      outcome: "current",
    });
  });

  it("says nothing when the metadata request fails, and retries within the hour", async () => {
    const run = await scenario({ httpFailure: true });
    const outcome = await runStartupUpdate(run.request);

    expect(outcome).toEqual({ kind: "failed", reason: "network" });
    expect(run.stderr()).toBe("");
    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toEqual({
      checkedAt: NOW.getTime(),
      outcome: "check-failed",
    });

    await runStartupUpdate(run.request);
    expect(run.requests).toHaveLength(1);
  });

  /**
   * The one failure that is not an inconvenience. It never suggests retrying by hand, and it never
   * gets the manual-update link the ordinary failure offers.
   */
  it("warns explicitly when the download does not match the published digest", async () => {
    const run = await scenario({ corrupt: true });
    await runStartupUpdate(run.request);

    expect(run.stderr()).toContain(
      "Acme Doctor refused the 1.4.0 update: the download did not match the release's published " +
        "SHA-256 digest. Nothing was installed.",
    );
    expect(run.stderr()).not.toContain("https://example.com/releases");
    expect(await readFile(run.executablePath, "utf8")).toBe("VERSION=1.3.0\n");
  });

  it("offers a manual path when the update could not be installed", async () => {
    const run = await scenario();
    await runStartupUpdate({
      ...run.request,
      host: {
        ...run.request.host,
        download: () => Promise.resolve({ kind: "failure", reason: "network" }),
      },
    });

    expect(run.stderr()).toContain(
      "Acme Doctor could not install the 1.4.0 update. Update manually: https://example.com/releases",
    );
  });

  it("backs off a candidate that failed to install", async () => {
    const run = await scenario();
    const failing = {
      ...run.request,
      host: {
        ...run.request.host,
        download: () => Promise.resolve({ kind: "failure", reason: "network" }),
      },
    } satisfies StartupUpdateRequest;

    await runStartupUpdate(failing);
    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toMatchObject({
      failedAttempts: 1,
      failedVersion: "1.4.0",
      outcome: "install-failed",
    });

    await runStartupUpdate(failing);
    expect(run.requests).toHaveLength(1);
  });

  it.each([
    { label: "the run is in CI", patch: { environmentVariables: { CI: "true" } } },
    {
      label: "the user turned updates off",
      patch: { environmentVariables: { ACME_UPDATE: "off" } },
    },
  ])("makes no request when $label", async ({ patch }) => {
    const run = await scenario();
    await runStartupUpdate({ ...run.request, ...patch });

    expect(run.requests).toEqual([]);
    expect(run.stderr()).toBe("");
    expect(await readFile(run.executablePath, "utf8")).toBe("VERSION=1.3.0\n");
  });
});
