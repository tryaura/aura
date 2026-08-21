import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { HttpGetRequest } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { readUpdateCache } from "./cache.js";
import { runStartupUpdate, type StartupUpdateRequest } from "./run.js";
import { sourceIdentity } from "./provider.js";
import { tarGzip } from "./tar-fixture.js";
import type { UpdateHost } from "./host.js";
import type { CliBranding } from "../types.js";
import type { CliUpdates } from "./types.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const BRANDING: CliBranding = {
  command: "acme",
  displayName: "Acme Doctor",
  docsUrl: "https://example.com/docs",
  version: "1.3.0",
};
const UPDATES: CliUpdates = {
  disableEnvironmentVariable: "ACME_UPDATE",
  manualUpdateUrl: "https://example.com/releases",
  source: {
    apiBaseUrl: "https://api.github.com",
    kind: "github-release",
    owner: "acme",
    repository: "acme-cli",
    requireImmutable: true,
  },
};
const IDENTITY = sourceIdentity(UPDATES.source, BRANDING.command);
const ARCHIVE = tarGzip([{ content: "VERSION=1.4.0\n", name: "acme" }]);
const DIGEST = createHash("sha256").update(ARCHIVE).digest("hex");

describe("startup update", () => {
  it("installs a newer release and says so in two lines on stderr", async () => {
    const run = await scenario();
    await runStartupUpdate(run.request);

    expect(run.stderr()).toBe(
      "Updating Acme Doctor 1.3.0 -> 1.4.0...\n" +
        "Updated Acme Doctor to 1.4.0. The new version will be used on your next run.\n",
    );
    expect(run.stdout()).toBe("");
    expect(await readFile(run.executablePath, "utf8")).toBe("VERSION=1.4.0\n");
  });

  it("records the install so the next command does not check again the same day", async () => {
    const run = await scenario();
    await runStartupUpdate(run.request);

    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toEqual({
      checkedAt: NOW.getTime(),
      outcome: "current",
    });

    await runStartupUpdate(run.request);
    expect(run.requests).toHaveLength(1);
  });

  it("says nothing when the release is the running one", async () => {
    const run = await scenario({ tag: "v1.3.0" });
    await runStartupUpdate(run.request);

    expect(run.stderr()).toBe("");
    expect(await readUpdateCache(run.homeDir, IDENTITY, NOW.getTime())).toMatchObject({
      outcome: "current",
    });
  });

  it("says nothing when the metadata request fails, and retries within the hour", async () => {
    const run = await scenario({ httpFailure: true });
    await runStartupUpdate(run.request);

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
      outcome: "candidate",
    });

    await runStartupUpdate(failing);
    expect(run.requests).toHaveLength(1);
  });

  it.each([
    { label: "the distribution declares no update source", patch: { updates: undefined } },
    { label: "the run is not a standalone installation", patch: { installation: undefined } },
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

async function scenario(
  options: {
    readonly corrupt?: boolean | undefined;
    readonly httpFailure?: boolean | undefined;
    readonly tag?: string | undefined;
  } = {},
): Promise<{
  readonly executablePath: string;
  readonly homeDir: string;
  readonly request: StartupUpdateRequest;
  readonly requests: HttpGetRequest[];
  readonly stderr: () => string;
  readonly stdout: () => string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "aura-startup-home-"));
  const directory = await mkdtemp(join(tmpdir(), "aura-startup-bin-"));
  const executablePath = join(directory, "acme");
  await writeFile(executablePath, "VERSION=1.3.0\n", { mode: 0o755 });

  const requests: HttpGetRequest[] = [];
  const stderr = capture();
  const stdout = capture();

  return {
    executablePath,
    homeDir,
    request: {
      branding: BRANDING,
      environmentVariables: {},
      homeDir,
      host: host(options.corrupt === true),
      httpGet: (request) => {
        requests.push(request);
        return Promise.resolve(
          options.httpFailure === true
            ? { kind: "failure", reason: "network" }
            : { body: release(options.tag ?? "v1.4.0"), kind: "response", status: 200 },
        );
      },
      installation: {
        architecture: "arm64",
        executablePath,
        kind: "standalone",
        platform: "darwin",
      },
      now: () => NOW,
      stderr: stderr.stream,
      stdin: terminal(),
      stdout: stdout.stream,
      updates: UPDATES,
    },
    requests,
    stderr: () => stderr.text(),
    stdout: () => stdout.text(),
  };
}

function release(tag: string): string {
  return JSON.stringify({
    assets: [
      {
        browser_download_url: `https://github.com/acme/acme-cli/releases/download/${tag}/acme-darwin-arm64.tar.gz`,
        digest: `sha256:${DIGEST}`,
        name: "acme-darwin-arm64.tar.gz",
        size: ARCHIVE.byteLength,
        url: "https://api.github.com/repos/acme/acme-cli/releases/assets/12",
      },
    ],
    draft: false,
    immutable: true,
    prerelease: false,
    tag_name: tag,
  });
}

function host(corrupt: boolean): UpdateHost {
  const bytes = corrupt ? tarGzip([{ content: "VERSION=6.6.6\n", name: "acme" }]) : ARCHIVE;
  return {
    download: async (request) => {
      await writeFile(request.destinationPath, bytes, { flag: "wx" });
      return { kind: "downloaded", sha256: createHash("sha256").update(bytes).digest("hex") };
    },
    isProcessAlive: () => false,
    pid: 4_242,
    probeVersion: async (path) => {
      const contents = await readFile(path, "utf8").catch(() => "");
      return /^VERSION=(?<version>.+)$/mu.exec(contents)?.groups?.["version"];
    },
  };
}

function terminal(): PassThrough {
  return Object.assign(new PassThrough(), { isTTY: true });
}

function capture(): { readonly stream: PassThrough; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = Object.assign(new PassThrough(), { isTTY: true });
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return { stream, text: () => chunks.join("") };
}
