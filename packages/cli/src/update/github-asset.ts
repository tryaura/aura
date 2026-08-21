import { MAX_ARCHIVE_BYTES } from "./limits.js";
import { asArray, asGitHubDigest, asRecord, asSize, asText } from "./narrow.js";
import type { CliUpdateSource } from "./types.js";

type GitHubSource = Extract<CliUpdateSource, { kind: "github-release" }>;

/** Host whose release assets are served from the separate `github.com` web origin. */
const PUBLIC_API_HOST = "api.github.com";
const PUBLIC_WEB_ORIGIN = "https://github.com";

/** One release asset, after every field a download depends on has been narrowed. */
export interface GitHubAsset {
  /** API URL, which is the only form that works for a private repository. */
  readonly apiUrl: string;
  /** Public web URL, pinned to the release tag. */
  readonly browserUrl: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * The one asset that names this release target, or `undefined` when the release cannot be used.
 *
 * "Exactly one" is the requirement, not "the first one". A release carrying two assets with the
 * same name is a publication that went wrong, and picking either would make which bytes a user
 * receives depend on GitHub's ordering.
 */
export function selectAsset(
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

/**
 * The download URL this release is required to publish.
 *
 * Compared rather than merely parsed: an accepted digest is only meaningful if the bytes come from
 * the release it was read out of, and a URL the response supplied freely is exactly the field an
 * attacker with write access to release metadata would move.
 */
function expectedBrowserUrl(source: GitHubSource, tag: string, name: string): string {
  return `${webOrigin(source)}/${source.owner}/${source.repository}/releases/download/${tag}/${name}`;
}

/** Whether the asset API URL sits under this source's own API root. */
function isExpectedApiUrl(source: GitHubSource, apiUrl: string): boolean {
  const prefix = `${trimSlash(source.apiBaseUrl)}/repos/${source.owner}/${source.repository}/releases/assets/`;
  return apiUrl.startsWith(prefix) && /^[0-9]+$/u.test(apiUrl.slice(prefix.length));
}

/**
 * Where this source's release assets are served from.
 *
 * github.com splits its API and its downloads across two hosts; a GitHub Enterprise Server serves
 * both from the instance, so its download origin is the API base's own.
 */
function webOrigin(source: GitHubSource): string {
  const url = parseUrl(source.apiBaseUrl);
  if (url === undefined) {
    return PUBLIC_WEB_ORIGIN;
  }
  return url.hostname === PUBLIC_API_HOST ? PUBLIC_WEB_ORIGIN : url.origin;
}

export function parseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    // A base carrying userinfo would put a credential into every derived URL, including the one
    // written to the metadata cache as part of a candidate.
    return url.username === "" && url.password === "" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
