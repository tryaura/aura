import { createPublicKey, verify, type KeyObject } from "node:crypto";

import { isAllowedHttpUrl } from "@tryaura/core";

import { MAX_ARCHIVE_BYTES, MAX_MANIFEST_FRESHNESS_MS } from "./limits.js";
import { asDigest, asRecord, asSize, asText, parseJson } from "./narrow.js";
import {
  bearer,
  compareRelease,
  downloadHeaders,
  etagField,
  fetchMetadata,
  sourceToken,
} from "./metadata.js";
import type { UpdateQuery, UpdateResolution } from "./provider.js";
import type { CliUpdates, UpdateCandidate, UpdateTarget } from "./types.js";

type ManifestSource = Extract<CliUpdates, { kind: "signed-manifest" }>;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;

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
      ? { etag: query.etag, kind: "current" }
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
  // Named apart from an untrusted signature on purpose. Both stop the update silently, and the two
  // have opposite fixes: one is an attack, the other is a publisher who dated a manifest outside
  // MAX_MANIFEST_FRESHNESS_MS and whose fleet then stops updating with nothing to read.
  if (!isFresh(document?.["expiresAt"], query.now)) {
    return { kind: "failure", reason: "stale-manifest" };
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
    candidate: { ...archive, version },
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

/** Returns the payload only when one trusted key verifies its exact bytes. */
function verifyEnvelope(
  envelope: unknown,
  trustedPublicKeys: readonly string[],
): string | undefined {
  const document = asRecord(envelope);
  if (document === undefined || document["schemaVersion"] !== 1) {
    return undefined;
  }
  const payload = decodeBase64Url(asText(document["payload"]));
  const signature = decodeBase64Url(asText(document["signature"]));
  if (payload === undefined || signature?.byteLength !== ED25519_SIGNATURE_BYTES) {
    return undefined;
  }
  const accepted = trustedPublicKeys
    .map((key) => publicKey(key))
    .some((key) => key !== undefined && verifySignature(key, payload, signature));
  return accepted ? payload.toString("utf8") : undefined;
}

function manifestAsset(
  assets: unknown,
  target: UpdateTarget,
  version: string,
): Omit<UpdateCandidate, "version"> | undefined {
  const entry = asRecord(asRecord(assets)?.[target]);
  const downloadUrl = asText(entry?.["downloadUrl"]);
  const sha256 = asDigest(entry?.["sha256"]);
  const size = asSize(entry?.["size"], MAX_ARCHIVE_BYTES);
  if (downloadUrl === undefined || sha256 === undefined || size === undefined) {
    return undefined;
  }
  return isPinnedUrl(downloadUrl, version) ? { downloadUrl, sha256, size } : undefined;
}

function isPinnedUrl(raw: string, version: string): boolean {
  try {
    const url = new URL(raw);
    return isAllowedHttpUrl(url) && `${url.pathname}${url.search}`.includes(version);
  } catch {
    return false;
  }
}

function verifySignature(key: KeyObject, payload: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, payload, key, signature);
  } catch {
    return false;
  }
}

function publicKey(encoded: string): KeyObject | undefined {
  const raw = Buffer.from(encoded, "base64");
  if (raw.byteLength !== ED25519_KEY_BYTES) {
    return undefined;
  }
  try {
    return createPublicKey({
      format: "der",
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      type: "spki",
    });
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string | undefined): Buffer | undefined {
  return value === undefined || !BASE64URL_PATTERN.test(value)
    ? undefined
    : Buffer.from(value, "base64url");
}
