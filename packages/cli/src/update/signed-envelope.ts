import { createPublicKey, verify, type KeyObject } from "node:crypto";

import { isAllowedHttpUrl } from "@tryaura/core";

import { MAX_ARCHIVE_BYTES } from "./limits.js";
import { asDigest, asRecord, asSize, asText } from "./narrow.js";
import type { CliUpdateCandidate, CliUpdateTarget } from "./types.js";

/** DER prefix that turns 32 raw Ed25519 public-key bytes into a SubjectPublicKeyInfo document. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;

/**
 * The decoded payload of a correctly signed envelope, or `undefined` for anything else.
 *
 * The signature covers the decoded payload bytes exactly, so re-encoding never enters the
 * verification: a canonicalization step is one more place two implementations can disagree, and a
 * disagreement here is a forged release that verifies.
 */
export function verifyEnvelope(
  envelope: unknown,
  trustedPublicKeys: readonly string[],
): string | undefined {
  const document = asRecord(envelope);
  if (document === undefined || document["schemaVersion"] !== 1) {
    return undefined;
  }
  const payload = decodeBase64Url(asText(document["payload"]));
  const signature = decodeBase64Url(asText(document["signature"]));
  if (payload === undefined || signature === undefined) {
    return undefined;
  }
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    return undefined;
  }
  // Every trusted key is tried, which is what makes rotation possible: a release signed by the
  // outgoing key can ship the binary that trusts its replacement before the old key is retired.
  const accepted = trustedPublicKeys
    .map((key) => publicKey(key))
    .some((key) => key !== undefined && verifySignature(key, payload, signature));
  return accepted ? payload.toString("utf8") : undefined;
}

/** The archive entry for one target, with its pinned URL, digest, and size all narrowed. */
export function manifestAsset(
  assets: unknown,
  target: CliUpdateTarget,
  version: string,
): CliUpdateCandidate["archive"] | undefined {
  const entry = asRecord(asRecord(assets)?.[target]);
  const downloadUrl = asText(entry?.["downloadUrl"]);
  const sha256 = asDigest(entry?.["sha256"]);
  const size = asSize(entry?.["size"], MAX_ARCHIVE_BYTES);
  if (downloadUrl === undefined || sha256 === undefined || size === undefined) {
    return undefined;
  }
  return isPinnedUrl(downloadUrl, version) ? { downloadUrl, sha256, size } : undefined;
}

/**
 * Whether an asset URL is pinned to the version the manifest resolved.
 *
 * A manifest may live at a stable "latest" address; the artifacts it names may not. A URL that
 * does not carry its own version is one a publication race can repoint between the moment the
 * digest was read and the moment the bytes are fetched.
 */
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

/**
 * Strict base64url decoding.
 *
 * `Buffer.from` accepts input it cannot round-trip, so the pattern check happens first: an
 * envelope whose payload silently loses bytes on decode is not one to run a signature over.
 */
function decodeBase64Url(value: string | undefined): Buffer | undefined {
  if (value === undefined || !BASE64URL_PATTERN.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64url");
}
