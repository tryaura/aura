import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { MAX_TEAM_PRESET_BYTES } from "../workspace/reader-limits.js";

/** The largest npm tarball Aura will decompress while looking for one preset document. */
export const MAX_TAR_BYTES = 32_000_000;

const BLOCK = 512;
const TYPE_HARD_LINK = 49;
const TYPE_SYMLINK = 50;
const TYPE_IMPLICIT_FILE = 0;
const TYPE_REGULAR_FILE = 48;

/** The extracted preset document, or why the archive could not yield one. */
export type ArchiveResult =
  | { readonly problem: string; readonly status: "invalid" }
  | { readonly status: "ready"; readonly text: string };

/** What the registry published about a tarball's contents, used to bind bytes to a version. */
export interface TarballIntegrity {
  readonly integrity?: string | undefined;
  readonly shasum?: string | undefined;
}

/**
 * Verifies downloaded bytes against the registry's published digest.
 *
 * The tarball URL comes out of metadata rather than from the reference the user typed, so the
 * bytes are only as trustworthy as whatever served them. The digest is what ties them back to the
 * version the registry actually resolved. A package with neither digest is refused rather than
 * trusted: an unverifiable artifact is exactly the one worth refusing.
 */
export function verifyTarballIntegrity(
  body: Uint8Array,
  published: TarballIntegrity,
): string | undefined {
  if (published.integrity !== undefined) {
    return verifySubresourceIntegrity(body, published.integrity);
  }
  if (published.shasum !== undefined) {
    return /^[0-9a-f]{40}$/u.test(published.shasum) &&
      equalDigests(createHash("sha1").update(body).digest(), Buffer.from(published.shasum, "hex"))
      ? undefined
      : "npm preset tarball does not match the shasum the registry published.";
  }
  return "npm preset metadata does not publish an integrity digest for the tarball.";
}

/**
 * Checks one SRI entry, accepting the strongest algorithm the registry offered.
 *
 * npm writes a single `sha512-…` today, but the grammar allows several space-separated options,
 * and a digest Aura cannot compute must fail closed rather than pass unchecked.
 */
function verifySubresourceIntegrity(body: Uint8Array, integrity: string): string | undefined {
  for (const entry of integrity.trim().split(/\s+/u)) {
    const separator = entry.indexOf("-");
    const algorithm = entry.slice(0, separator);
    const expected = entry.slice(separator + 1);
    if (separator <= 0 || (algorithm !== "sha256" && algorithm !== "sha512")) {
      continue;
    }
    if (
      !equalDigests(createHash(algorithm).update(body).digest(), Buffer.from(expected, "base64"))
    ) {
      return "npm preset tarball does not match the integrity digest the registry published.";
    }
    return undefined;
  }
  return "npm preset metadata publishes no integrity digest Aura can verify.";
}

function equalDigests(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Reads `package/preset.json` out of a gzipped tar without writing anything to disk.
 *
 * Nothing here is extracted, so the path rules are not about escaping a destination directory:
 * they keep a crafted archive from renaming some other entry into the one file this trusts.
 */
// fallow-ignore-next-line complexity -- every archive branch rejects one distinct unsafe tar condition.
export function extractPresetJson(compressed: Uint8Array): ArchiveResult {
  let archive: Uint8Array;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    return invalid("npm preset tarball is not a valid bounded gzip archive.");
  }

  let offset = 0;
  let preset: Uint8Array | undefined;
  const paths = new Set<string>();
  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      break;
    }
    if (!validTarChecksum(header)) {
      return invalid("npm preset tarball has an invalid header checksum.");
    }
    const name = tarName(header);
    if (unsafeTarPath(name)) {
      return invalid("npm preset tarball contains an unsafe entry path.");
    }
    if (paths.has(name)) {
      return invalid("npm preset tarball contains a duplicate entry path.");
    }
    paths.add(name);
    const size = tarSize(header);
    if (size === undefined || offset + BLOCK + size > archive.byteLength) {
      return invalid("npm preset tarball has an invalid entry size.");
    }
    const type = header[156] ?? TYPE_IMPLICIT_FILE;
    if (type === TYPE_HARD_LINK || type === TYPE_SYMLINK) {
      return invalid("npm preset tarball contains a link entry.");
    }
    if (name === "package/preset.json") {
      if (preset !== undefined) {
        return invalid("npm preset tarball contains more than one preset.json.");
      }
      if (type !== TYPE_IMPLICIT_FILE && type !== TYPE_REGULAR_FILE) {
        return invalid("npm preset tarball preset.json is not a regular file.");
      }
      if (size > MAX_TEAM_PRESET_BYTES) {
        return invalid("npm preset tarball preset.json exceeds the preset size limit.");
      }
      preset = archive.slice(offset + BLOCK, offset + BLOCK + size);
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (preset === undefined) {
    return invalid("npm preset tarball does not contain package/preset.json.");
  }
  try {
    return { status: "ready", text: new TextDecoder("utf-8", { fatal: true }).decode(preset) };
  } catch {
    return invalid("npm preset tarball preset.json is not valid UTF-8.");
  }
}

function unsafeTarPath(path: string): boolean {
  return (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "..")
  );
}

function tarName(header: Uint8Array): string {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  return prefix === "" ? name : `${prefix}/${name}`;
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function tarSize(header: Uint8Array): number | undefined {
  const raw = tarString(header.subarray(124, 136)).trim();
  if (!/^[0-7]+$/u.test(raw)) {
    return undefined;
  }
  const size = Number.parseInt(raw, 8);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function validTarChecksum(header: Uint8Array): boolean {
  const raw = tarString(header.subarray(148, 156)).trim();
  if (!/^[0-7]+$/u.test(raw)) {
    return false;
  }
  let sum = 0;
  for (const [index, byte] of header.entries()) {
    sum += index >= 148 && index < 156 ? 32 : byte;
  }
  return sum === Number.parseInt(raw, 8);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function invalid(problem: string): ArchiveResult {
  return { problem, status: "invalid" };
}
