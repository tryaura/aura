import { MAX_METADATA_BYTES, METADATA_TIMEOUT_MS } from "./limits.js";
import { isInstallableVersion, isNewerVersion } from "./target.js";
import type { UpdateQuery } from "./provider.js";

/** One metadata document, or the two non-answers every provider treats identically. */
export type MetadataResponse =
  | { readonly body: string; readonly etag?: string | undefined; readonly kind: "body" }
  /** The server confirmed the caller's cached copy is still current. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "failure" };

/**
 * Fetches one release-metadata document under the shared caps.
 *
 * Both providers ask the same questions of a response — did it arrive, is it a 304, is it a 200 —
 * and both must answer a credential-bearing request without letting the reason travel with the
 * result. Keeping that in one place is what stops the two from drifting apart.
 */
export async function fetchMetadata(
  query: UpdateQuery,
  options: {
    readonly accept: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly url: string;
  },
): Promise<MetadataResponse> {
  const response = await query.httpGet({
    headers: {
      accept: options.accept,
      "user-agent": query.userAgent,
      ...options.headers,
      ...(query.etag === undefined ? {} : { "if-none-match": query.etag }),
    },
    maxResponseBytes: MAX_METADATA_BYTES,
    timeoutMs: METADATA_TIMEOUT_MS,
    url: options.url,
  });

  if (response.kind !== "response") {
    return { kind: "failure" };
  }
  if (response.status === 304) {
    return { kind: "unchanged" };
  }
  if (response.status !== 200) {
    return { kind: "failure" };
  }
  return {
    body: response.body,
    ...(response.etag === undefined ? {} : { etag: response.etag }),
    kind: "body",
  };
}

/**
 * The `Authorization` header for a configured credential, or no header at all.
 *
 * Built at the call site and never stored: the value leaves scope with the request it authorizes.
 */
export function bearer(token: string | undefined): Readonly<Record<string, string>> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/** Headers the archive download carries. Rebuilt per lookup, so nothing cached holds a secret. */
export function downloadHeaders(token: string | undefined): Readonly<Record<string, string>> {
  return { accept: "application/octet-stream", ...bearer(token) };
}

/**
 * How a resolved release version compares to the running one.
 *
 * Both providers answer the same three-way question before they look at an asset, and both have to
 * answer it identically: a version that is merely parseable, or merely different, is not one to
 * install over a working binary.
 */
export type VersionVerdict =
  | { readonly kind: "newer"; readonly version: string }
  | { readonly kind: "current" }
  | { readonly kind: "invalid" };

export function compareRelease(version: string | undefined, current: string): VersionVerdict {
  if (version === undefined || !isInstallableVersion(version)) {
    return { kind: "invalid" };
  }
  return isNewerVersion(version, current) ? { kind: "newer", version } : { kind: "current" };
}

/** An entity tag as an optional field, so absence stays absent rather than `undefined`-valued. */
export function etagField(etag: string | undefined): { readonly etag?: string } {
  return etag === undefined ? {} : { etag };
}

/** Reads a source's configured credential, when it names one. */
export function sourceToken(
  query: UpdateQuery,
  tokenEnvironmentVariable: string | undefined,
): string | undefined {
  return tokenEnvironmentVariable === undefined
    ? undefined
    : query.readVariable(tokenEnvironmentVariable);
}
