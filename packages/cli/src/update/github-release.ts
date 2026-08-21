import { asFlag, asRecord, asText, parseJson } from "./narrow.js";
import {
  bearer,
  compareRelease,
  downloadHeaders,
  etagField,
  fetchMetadata,
  sourceToken,
} from "./metadata.js";
import { parseUrl, selectAsset, trimSlash, type GitHubAsset } from "./github-asset.js";
import type { UpdateQuery, UpdateResolution } from "./provider.js";
import type { CliUpdateSource } from "./types.js";

type GitHubSource = Extract<CliUpdateSource, { kind: "github-release" }>;

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
  if (parseUrl(source.apiBaseUrl) === undefined) {
    return { kind: "failure", reason: "invalid-release" };
  }
  const token = sourceToken(query, source.tokenEnvironmentVariable);
  const response = await fetchMetadata(query, {
    accept: "application/vnd.github+json",
    headers: { ...bearer(token), "x-github-api-version": GITHUB_API_VERSION },
    url: `${trimSlash(source.apiBaseUrl)}/repos/${source.owner}/${source.repository}/releases/latest`,
  });

  if (response.kind !== "body") {
    return response.kind === "unchanged"
      ? { kind: "unchanged" }
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
  if (source.requireImmutable && asFlag(release["immutable"]) !== true) {
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
      archive: {
        downloadUrl: token === undefined ? asset.browserUrl : asset.apiUrl,
        sha256: asset.sha256,
        size: asset.size,
      },
      version,
    },
    downloadHeaders: downloadHeaders(token),
    kind: "candidate",
    ...etagField(etag),
  };
}
