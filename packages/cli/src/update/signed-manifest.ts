import { MAX_MANIFEST_FRESHNESS_MS } from "./limits.js";
import { asRecord, asSize, asText, parseJson } from "./narrow.js";
import {
  bearer,
  compareRelease,
  downloadHeaders,
  etagField,
  fetchMetadata,
  sourceToken,
} from "./metadata.js";
import { manifestAsset, verifyEnvelope } from "./signed-envelope.js";
import type { UpdateQuery, UpdateResolution } from "./provider.js";
import type { CliUpdateSource } from "./types.js";

type ManifestSource = Extract<CliUpdateSource, { kind: "signed-manifest" }>;

/**
 * Resolves a release from one signed HTTPS manifest.
 *
 * For deployments a GitHub-shaped provider cannot serve honestly — an internal artifact service, or
 * a GitHub Enterprise Server without immutable releases and per-asset digests. The trust boundary
 * moves from the transport to the signature, so the manifest URL itself may be a stable "latest"
 * reference while every asset URL inside it stays pinned to the version it names.
 */
export async function resolveSignedManifest(
  source: ManifestSource,
  query: UpdateQuery,
): Promise<UpdateResolution> {
  const token = sourceToken(query, source.tokenEnvironmentVariable);
  const response = await fetchMetadata(query, {
    accept: "application/json",
    headers: bearer(token),
    url: source.manifestUrl,
  });

  if (response.kind !== "body") {
    return response.kind === "unchanged"
      ? { kind: "unchanged" }
      : { kind: "failure", reason: "network" };
  }
  return narrowManifest(source, query, response.body, response.etag, token);
}

function narrowManifest(
  source: ManifestSource,
  query: UpdateQuery,
  body: string,
  etag: string | undefined,
  token: string | undefined,
): UpdateResolution {
  const payload = verifyEnvelope(parseJson(body), source.trustedPublicKeys);
  if (payload === undefined) {
    return { kind: "failure", reason: "untrusted-release" };
  }
  const document = asRecord(parseJson(payload));
  if (!isFresh(document?.["expiresAt"], query.now)) {
    return { kind: "failure", reason: "untrusted-release" };
  }
  const verdict = compareRelease(asText(document?.["version"]), query.version);
  if (verdict.kind !== "newer") {
    return verdict.kind === "current"
      ? { kind: "current", ...etagField(etag) }
      : { kind: "failure", reason: "invalid-release" };
  }
  return candidate(source, query, document?.["assets"], verdict.version, etag, token);
}

/** The resolved release, with the credential attached only where it is the caller's to send. */
function candidate(
  source: ManifestSource,
  query: UpdateQuery,
  assets: unknown,
  version: string,
  etag: string | undefined,
  token: string | undefined,
): UpdateResolution {
  const archive = manifestAsset(assets, query.target, version);
  if (archive === undefined) {
    return { kind: "failure", reason: "invalid-release" };
  }
  return {
    candidate: { archive, version },
    // A manifest credential authorizes the service the distribution configured, not every origin a
    // signed payload may name. Cross-origin assets must use their own signed URL.
    downloadHeaders: downloadHeaders(
      sameOrigin(source.manifestUrl, archive.downloadUrl) ? token : undefined,
    ),
    kind: "candidate",
    ...etagField(etag),
  };
}

/**
 * Whether a signed manifest is still within the window it signed for.
 *
 * Required, not optional: a publisher who omits the field would otherwise get a document that is
 * valid forever, which is exactly the one an attacker wants to keep replaying. Epoch milliseconds
 * rather than a formatted timestamp, so reading it needs no clock, locale, or calendar.
 */
function isFresh(expiresAt: unknown, now: number): boolean {
  const expiry = asSize(expiresAt, Number.MAX_SAFE_INTEGER);
  if (expiry === undefined || expiry <= now) {
    return false;
  }
  return expiry - now <= MAX_MANIFEST_FRESHNESS_MS;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
