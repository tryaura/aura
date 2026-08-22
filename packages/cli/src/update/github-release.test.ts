import type { HttpGetRequest, HttpGetResult } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { resolveGitHubRelease } from "./github-release.js";
import type { UpdateQuery, UpdateResolution } from "./provider.js";
import type { CliUpdateSource } from "./types.js";

const DIGEST = "a".repeat(64);
/** Fixed, because this provider never reads it: only a signed manifest has a freshness window. */
const NOW = 1_760_000_000_000;

const SOURCE: Extract<CliUpdateSource, { kind: "github-release" }> = {
  apiBaseUrl: "https://api.github.com",
  kind: "github-release",
  owner: "acme",
  repository: "acme-cli",
  requireImmutable: true,
};

describe("GitHub release provider", () => {
  it("accepts an immutable release and pins its download to the tag", async () => {
    const { requests, resolution } = await resolve();

    expect(resolution).toEqual({
      candidate: {
        archive: {
          downloadUrl:
            "https://github.com/acme/acme-cli/releases/download/v1.4.0/acme-darwin-arm64.tar.gz",
          sha256: DIGEST,
          size: 1_024,
        },
        version: "1.4.0",
      },
      downloadHeaders: { accept: "application/octet-stream" },
      etag: '"release-1"',
      kind: "candidate",
    });
    expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/acme-cli/releases/latest");
    expect(requests[0]?.headers).toMatchObject({ "x-github-api-version": expect.any(String) });
    expect(requests[0]?.headers?.["authorization"]).toBeUndefined();
  });

  it("reports the running version as current when no release is newer", async () => {
    const { resolution } = await resolve({ release: { tag_name: "v1.3.0" } });
    expect(resolution).toEqual({ etag: '"release-1"', kind: "current" });
  });

  it("revalidates with the cached entity tag", async () => {
    const { requests, resolution } = await resolve({ etag: '"cached"', status: 304 });
    expect(requests[0]?.headers?.["if-none-match"]).toBe('"cached"');
    expect(resolution).toEqual({ kind: "unchanged" });
  });

  it.each([
    { label: "a transport failure", result: { kind: "failure", reason: "timeout" } as const },
    { label: "a server error", result: undefined, status: 500 },
  ])("treats $label as a silent network failure", async ({ result, status }) => {
    const { resolution } = await resolve({
      ...(result === undefined ? {} : { result }),
      ...(status === undefined ? {} : { status }),
    });
    expect(resolution).toEqual({ kind: "failure", reason: "network" });
  });

  it.each([
    { label: "a draft", release: { draft: true } },
    { label: "a prerelease", release: { prerelease: true } },
    { label: "a release that does not report draft state", release: { draft: undefined } },
    { label: "a tag without the v prefix", release: { tag_name: "1.4.0" } },
    { label: "a non-canonical tag", release: { tag_name: "v1.4" } },
    { label: "an unstamped tag", release: { tag_name: "v0.0.0" } },
  ])("refuses $label", async ({ release }) => {
    const { resolution } = await resolve({ release });
    expect(resolution).toEqual({ kind: "failure", reason: "invalid-release" });
  });

  it.each([
    { label: "a mutable release", release: { immutable: false } },
    { label: "a release that cannot report immutability", release: { immutable: undefined } },
  ])("refuses $label when immutability is required", async ({ release }) => {
    const { resolution } = await resolve({ release });
    expect(resolution).toEqual({ kind: "failure", reason: "untrusted-release" });
  });

  it.each([
    { asset: { digest: undefined }, label: "no digest" },
    { asset: { digest: DIGEST }, label: "an unprefixed digest" },
    { asset: { digest: `sha256:${DIGEST.toUpperCase()}` }, label: "a non-lowercase digest" },
    { asset: { digest: "sha512:" + "a".repeat(128) }, label: "a digest of another algorithm" },
    { asset: { size: 0 }, label: "a zero size" },
    { asset: { size: 1e12 }, label: "a size beyond the bound" },
    {
      asset: {
        browser_download_url: "https://cdn.example.com/acme-darwin-arm64.tar.gz",
      },
      label: "a download URL off the release",
    },
    {
      asset: { url: "https://api.github.com/repos/other/other/releases/assets/12" },
      label: "an asset API URL from another repository",
    },
  ])("refuses an asset with $label", async ({ asset }) => {
    const { resolution } = await resolve({ asset });
    expect(resolution).toEqual({ kind: "failure", reason: "invalid-release" });
  });

  it("refuses a release carrying two assets for this target", async () => {
    const { resolution } = await resolve({ release: { assets: [asset(), asset()] } });
    expect(resolution).toEqual({ kind: "failure", reason: "invalid-release" });
  });

  it("refuses a release with no asset for this target", async () => {
    const { resolution } = await resolve({
      release: { assets: [asset({ name: "acme-linux-x64.tar.gz" })] },
    });
    expect(resolution).toEqual({ kind: "failure", reason: "invalid-release" });
  });

  /**
   * A private release is fetched and downloaded through the API, which is the only form that
   * authenticates. The token reaches the request headers and the download headers, and nothing
   * else: the candidate is the value that gets written to the metadata cache.
   */
  it("authenticates a private release without letting the token reach the candidate", async () => {
    const { requests, resolution } = await resolve({
      source: { ...SOURCE, tokenEnvironmentVariable: "ACME_TOKEN" },
      variables: { ACME_TOKEN: "ghp_secret" },
    });

    expect(requests[0]?.headers?.["authorization"]).toBe("Bearer ghp_secret");
    expect(resolution).toMatchObject({
      candidate: {
        archive: { downloadUrl: "https://api.github.com/repos/acme/acme-cli/releases/assets/12" },
      },
      downloadHeaders: { authorization: "Bearer ghp_secret" },
    });
    expect(JSON.stringify(resolution)).toContain("ghp_secret");
    const candidate = resolution.kind === "candidate" ? resolution.candidate : undefined;
    expect(JSON.stringify(candidate)).not.toContain("ghp_secret");
  });
});

function asset(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    browser_download_url:
      "https://github.com/acme/acme-cli/releases/download/v1.4.0/acme-darwin-arm64.tar.gz",
    digest: `sha256:${DIGEST}`,
    name: "acme-darwin-arm64.tar.gz",
    size: 1_024,
    url: "https://api.github.com/repos/acme/acme-cli/releases/assets/12",
    ...overrides,
  };
}

async function resolve(
  options: {
    readonly asset?: Readonly<Record<string, unknown>> | undefined;
    readonly etag?: string | undefined;
    readonly release?: Readonly<Record<string, unknown>> | undefined;
    readonly result?: HttpGetResult | undefined;
    readonly source?: Extract<CliUpdateSource, { kind: "github-release" }> | undefined;
    readonly status?: number | undefined;
    readonly variables?: Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<{ requests: HttpGetRequest[]; resolution: UpdateResolution }> {
  const requests: HttpGetRequest[] = [];
  const body = JSON.stringify({
    assets: [asset(options.asset ?? {})],
    draft: false,
    immutable: true,
    prerelease: false,
    tag_name: "v1.4.0",
    ...options.release,
  });
  const query: UpdateQuery = {
    command: "acme",
    ...(options.etag === undefined ? {} : { etag: options.etag }),
    httpGet: (request) => {
      requests.push(request);
      return Promise.resolve(
        options.result ?? {
          body,
          etag: '"release-1"',
          kind: "response",
          status: options.status ?? 200,
        },
      );
    },
    now: NOW,
    readVariable: (name) => options.variables?.[name],
    target: "darwin-arm64",
    userAgent: "acme/1.3.0",
    version: "1.3.0",
  };
  return { requests, resolution: await resolveGitHubRelease(options.source ?? SOURCE, query) };
}
