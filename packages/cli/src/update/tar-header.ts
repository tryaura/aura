/**
 * The one tar header shape the updater accepts.
 *
 * A general-purpose extractor is the wrong tool here: the archives this reads contain exactly two
 * known files, and every other entry kind a tar can carry — symlinks, hard links, devices, PAX and
 * GNU extension records — is a way to write outside the destination or to smuggle a second
 * executable past the version check. Anything not explicitly allowed is refused.
 */

export const TAR_BLOCK_BYTES = 512;

const NAME = { length: 100, offset: 0 };
const SIZE = { length: 12, offset: 124 };
const CHECKSUM = { length: 8, offset: 148 };
const TYPEFLAG_OFFSET = 156;
const PREFIX = { length: 155, offset: 345 };

/** Type flags for a plain file. `0` is ustar; NUL is the historic spelling of the same thing. */
const REGULAR_TYPES: ReadonlySet<string> = new Set(["0", "\0"]);

export interface TarEntry {
  readonly name: string;
  readonly size: number;
}

/** Whether a block is all zeroes, which is how a tar announces its own end. */
export function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * One header, or `undefined` for any block this extractor refuses to act on.
 *
 * Refusal is deliberately undifferentiated: the caller aborts the whole archive either way, and a
 * reason string would only invite someone to relax a specific case later.
 */
export function parseTarHeader(block: Uint8Array): TarEntry | undefined {
  if (!hasValidChecksum(block)) {
    return undefined;
  }
  if (!REGULAR_TYPES.has(String.fromCharCode(block[TYPEFLAG_OFFSET] ?? 0))) {
    return undefined;
  }
  const size = parseOctal(block, SIZE);
  const name = entryName(block);
  return size === undefined || name === undefined ? undefined : { name, size };
}

/**
 * The entry path, refused unless it is a plain relative name.
 *
 * Absolute paths, parent traversal, and Windows separators are all ways to make an extraction land
 * somewhere the caller did not choose, and none of them appear in an archive this project builds.
 */
function entryName(block: Uint8Array): string | undefined {
  const prefix = readString(block, PREFIX);
  const base = readString(block, NAME);
  if (base === "") {
    return undefined;
  }
  const joined = prefix === "" ? base : `${prefix}/${base}`;
  const normalized = joined.startsWith("./") ? joined.slice(2) : joined;
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || normalized.includes("\\")) {
    return undefined;
  }
  return segments.some((segment) => segment === ".." || segment === "") ? undefined : normalized;
}

/**
 * The header checksum, which every tar writer sets and every reader is expected to verify.
 *
 * Checked here because it is the cheapest way to notice that the stream has drifted out of block
 * alignment — a state in which arbitrary payload bytes would otherwise be read as a header.
 */
function hasValidChecksum(block: Uint8Array): boolean {
  const declared = parseOctal(block, CHECKSUM);
  if (declared === undefined) {
    return false;
  }
  let sum = 0;
  for (const [index, byte] of block.entries()) {
    const inChecksum = index >= CHECKSUM.offset && index < CHECKSUM.offset + CHECKSUM.length;
    sum += inChecksum ? 0x20 : byte;
  }
  return sum === declared;
}

/**
 * A NUL- or space-terminated octal field.
 *
 * Base-256 encoded fields — the GNU extension for sizes beyond 8 GiB — are refused rather than
 * decoded: nothing this extracts is that large, and the size field is what bounds the write.
 */
function parseOctal(
  block: Uint8Array,
  field: { length: number; offset: number },
): number | undefined {
  const bytes = block.subarray(field.offset, field.offset + field.length);
  if ((bytes[0] ?? 0) & 0x80) {
    return undefined;
  }
  const text = readString(block, field).trim();
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]+$/u.test(text)) {
    return undefined;
  }
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readString(block: Uint8Array, field: { length: number; offset: number }): string {
  const bytes = block.subarray(field.offset, field.offset + field.length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end)).replace(/\0+$/u, "");
}
