import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { vetHttpUrl } from "@tryaura/core";

import { DOWNLOAD_TIMEOUT_MS, MAX_REDIRECTS } from "./limits.js";
import type { UpdateDownloadRequest, UpdateDownloadResult, UpdateHost } from "./host.js";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Creates the archive downloader: a bounded, TLS-only stream straight to disk.
 *
 * This is the one place in the updater that reaches the network directly. `Environment.httpGet`
 * cannot do this job — it buffers into memory and refuses redirects outright — and a release
 * archive is both too large to hold in the heap and, for a private repository, served through a
 * redirect to a temporary signed URL. The rules `httpGet` enforces are reimplemented rather than
 * relaxed: HTTPS only, a hop limit, and `Authorization` stripped the moment the origin changes.
 */
export function createUpdateDownload(): UpdateHost["download"] {
  return async (request) => {
    try {
      return await stream(request);
    } catch {
      return { kind: "failure", reason: "network" };
    }
  };
}

async function stream(request: UpdateDownloadRequest): Promise<UpdateDownloadResult> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = await follow(request, signal);
  if (typeof response === "string") {
    return { kind: "failure", reason: response };
  }
  if (response.status !== 200 || response.body === null) {
    return { kind: "failure", reason: "network" };
  }
  // A server that announces a different length than the release metadata did is already serving
  // something other than the bytes the digest was published for.
  const declared = response.headers.get("content-length");
  if (declared !== null && declared !== String(request.expectedBytes)) {
    return { kind: "failure", reason: "unexpected-length" };
  }
  return await writeBody(response.body, request);
}

/** Streams the body to a fresh file, counting and hashing as it goes. */
async function writeBody(
  body: ReadableStream<Uint8Array>,
  request: UpdateDownloadRequest,
): Promise<UpdateDownloadResult> {
  const hash = createHash("sha256");
  let received = 0;
  // `wx` on purpose: the installer supplies a path it just invented, and a download that would
  // land on an existing file is a collision worth failing on rather than overwriting.
  const handle = await open(request.destinationPath, "wx", 0o600);
  try {
    for await (const chunk of body) {
      received += chunk.byteLength;
      if (received > request.expectedBytes) {
        return { kind: "failure", reason: "too-large" };
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (received !== request.expectedBytes) {
      return { kind: "failure", reason: "unexpected-length" };
    }
    await handle.sync();
    return { kind: "downloaded", sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/**
 * Follows redirects by hand so each hop is vetted before it is taken.
 *
 * `Authorization` survives only a same-origin hop. GitHub answers an authenticated asset request
 * with a redirect to a signed storage URL that needs no credential of its own, so forwarding one
 * there would hand a repository token to a host the caller never named.
 */
async function follow(
  request: UpdateDownloadRequest,
  signal: AbortSignal,
): Promise<Response | "insecure-url" | "network"> {
  let url = vetHttpUrl(request.url);
  let headers: Record<string, string> = { ...request.headers };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!(url instanceof URL)) {
      return url === "insecure-url" ? "insecure-url" : "network";
    }
    const response = await fetch(url, { headers, method: "GET", redirect: "manual", signal });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return response;
    }
    const origin = url.origin;
    url = vetHttpUrl(new URL(location, url).href);
    if (url instanceof URL && url.origin !== origin) {
      headers = withoutAuthorization(headers);
    }
  }
  return "network";
}

function withoutAuthorization(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
}
