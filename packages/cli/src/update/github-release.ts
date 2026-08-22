import { MAX_ARCHIVE_BYTES } from "./limits.js";
import { asArray, asFlag, asGitHubDigest, asRecord, asSize, asText, parseJson } from "./narrow.js";
import {
  bearer,
  compareRelease,
  downloadHeaders,
  etagField,
  fetchMetadata,
  sourceToken,
} from "./metadata.js";
import type { UpdateQuery, UpdateResolution } from "./provider.js";
import type { CliUpdates } from "./types.js";

type GitHubSource = Extract<CliUpdates, { kind: "github-release" }>;

const PUBLIC_API_BASE_URL = "https://api.github.com";
const PUBLIC_API_HOST = "api.github.com";
const PUBLIC_WEB_ORIGIN = "https://github.com";

interface GitHubAsset {
  readonly apiUrl: string;
  readonly browserUrl: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * REST API version this provider is written against.
 *
 * Pinned rather than omitted: the response fields the trust decision rests on — `immutable` and
 * the per-asset `digest` — are the ones a future default version could reshape.
 */
const GITHUB_API_VERSION = "2026-03-10";

/**
 * Resolves the latest release of one GitHub or GitHub Enterprise Server repository.
 *
 * The trust boundary is the API's TLS connection plus immutable releases: one authenticated
 * document supplies the version, the asset, and the digest together, so there is no second
 * endpoint, moving URL, or long-lived signing key to defend.
 */
export async function resolveGitHubRelease(
  source: GitHubSource,
  query: UpdateQuery,
): Promise<UpdateResolution> {
  const baseUrl = source.apiBaseUrl ?? PUBLIC_API_BASE_URL;
  if (parseUrl(baseUrl) === undefined) {
    return { kind: "failure", reason: "invalid-release" };
  }
  const token = sourceToken(query, source.tokenEnvironmentVariable);
  const response = await fetchMetadata(query, {
    accept: "application/vnd.github+json",
    headers: { ...bearer(token), "x-github-api-version": GITHUB_API_VERSION },
    url: `${trimSlash(baseUrl)}/repos/${source.owner}/${source.repository}/releases/latest`,
  });

  if (response.kind !== "body") {
    return response.kind === "unchanged"
      ? { etag: query.etag, kind: "current" }
      : { kind: "failure", reason: "network" };
  }
  return narrowRelease(source, query, parseJson(response.body), response.etag, token);
}

/** Turns the response body into a candidate, refusing every release that is not exactly usable. */
function narrowRelease(
  source: GitHubSource,
  query: UpdateQuery,
  document: unknown,
  etag: string | undefined,
  token: string | undefined,
): UpdateResolution {
  const release = asRecord(document);
  if (release === undefined || !isPublished(release)) {
    return { kind: "failure", reason: "invalid-release" };
  }
  if (asFlag(release["immutable"]) !== true) {
    return { kind: "failure", reason: "untrusted-release" };
  }

  const tag = asText(release["tag_name"]) ?? "";
  const verdict = compareRelease(releaseVersion(tag), query.version);
  if (verdict.kind !== "newer") {
    return verdict.kind === "current"
      ? { kind: "current", ...etagField(etag) }
      : { kind: "failure", reason: "invalid-release" };
  }

  const asset = selectAsset(source, release["assets"], assetName(query), tag);
  return asset === undefined
    ? { kind: "failure", reason: "invalid-release" }
    : candidate(asset, verdict.version, etag, token);
}

/**
 * Whether the release is a published, final one.
 *
 * Absent reads as unusable rather than as `false`: a server that stopped reporting draft state must
 * not have every draft silently promoted to installable.
 */
function isPublished(release: Record<string, unknown>): boolean {
  return asFlag(release["draft"]) === false && asFlag(release["prerelease"]) === false;
}

/** The version a `v`-prefixed tag names, or `undefined` for any other tag shape. */
function releaseVersion(tag: string): string | undefined {
  return tag.startsWith("v") ? tag.slice(1) : undefined;
}

/** The archive name a release must publish for this target, and the only one accepted. */
function assetName(query: UpdateQuery): string {
  return `${query.command}-${query.target}.tar.gz`;
}

/**
 * The candidate, downloading through the API when a token is configured.
 *
 * A private repository serves assets only from the API URL with an octet-stream `Accept`, which
 * answers with the bytes or with a redirect to a temporary signed URL. Public releases keep the
 * plain browser URL so an unauthenticated download stays unauthenticated.
 */
function candidate(
  asset: GitHubAsset,
  version: string,
  etag: string | undefined,
  token: string | undefined,
): UpdateResolution {
  return {
    candidate: {
      downloadUrl: token === undefined ? asset.browserUrl : asset.apiUrl,
      sha256: asset.sha256,
      size: asset.size,
      version,
    },
    downloadHeaders: downloadHeaders(token),
    kind: "candidate",
    ...etagField(etag),
  };
}

/** Selects exactly one target asset and narrows every field the download depends on. */
function selectAsset(
  source: GitHubSource,
  assets: unknown,
  expectedName: string,
  tag: string,
): GitHubAsset | undefined {
  const entries = asArray(assets);
  if (entries === undefined) {
    return undefined;
  }
  const matches = entries
    .map((entry) => asRecord(entry))
    .filter((entry) => entry !== undefined && asText(entry["name"]) === expectedName);
  if (matches.length !== 1) {
    return undefined;
  }
  return narrowAsset(source, matches[0], expectedName, tag);
}

function narrowAsset(
  source: GitHubSource,
  asset: Record<string, unknown> | undefined,
  expectedName: string,
  tag: string,
): GitHubAsset | undefined {
  if (asset === undefined) {
    return undefined;
  }
  const size = asSize(asset["size"], MAX_ARCHIVE_BYTES);
  const sha256 = asGitHubDigest(asset["digest"]);
  const browserUrl = asText(asset["browser_download_url"]);
  const apiUrl = asText(asset["url"]);
  if (size === undefined || sha256 === undefined || browserUrl === undefined) {
    return undefined;
  }
  if (apiUrl === undefined || !isExpectedApiUrl(source, apiUrl)) {
    return undefined;
  }
  if (browserUrl !== expectedBrowserUrl(source, tag, expectedName)) {
    return undefined;
  }
  return { apiUrl, browserUrl, sha256, size };
}

function expectedBrowserUrl(source: GitHubSource, tag: string, name: string): string {
  return `${webOrigin(source)}/${source.owner}/${source.repository}/releases/download/${tag}/${name}`;
}

function isExpectedApiUrl(source: GitHubSource, apiUrl: string): boolean {
  const baseUrl = source.apiBaseUrl ?? PUBLIC_API_BASE_URL;
  const prefix = `${trimSlash(baseUrl)}/repos/${source.owner}/${source.repository}/releases/assets/`;
  return apiUrl.startsWith(prefix) && /^[0-9]+$/u.test(apiUrl.slice(prefix.length));
}

function webOrigin(source: GitHubSource): string {
  const url = parseUrl(source.apiBaseUrl ?? PUBLIC_API_BASE_URL);
  if (url === undefined) {
    return PUBLIC_WEB_ORIGIN;
  }
  return url.hostname === PUBLIC_API_HOST ? PUBLIC_WEB_ORIGIN : url.origin;
}

function parseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.username === "" && url.password === "" ? url : undefined;
  } catch {
    return undefined;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
