/**
 * Narrowing helpers for provider responses.
 *
 * Every release document is unknown input from a server, so nothing reads a field without proving
 * its shape first. These return `undefined` rather than throwing: a provider turns absence into a
 * refusal, and a refusal is never fatal to the command the user actually asked for.
 */

/** 64 lowercase hexadecimal characters, the only digest form the updater accepts. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const GITHUB_DIGEST_PREFIX = "sha256:";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** A non-empty string, since an empty name or URL is never a value the updater can act on. */
export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A boolean, and only a boolean: a missing `immutable` field must not read as `false`. */
export function asFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A positive safe integer within `ceiling`, which is what a byte size has to be to be usable. */
export function asSize(value: unknown, ceiling: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value <= ceiling ? value : undefined;
}

/** A bare lowercase SHA-256 digest. */
export function asDigest(value: unknown): string | undefined {
  const text = asText(value);
  return text !== undefined && SHA256_PATTERN.test(text) ? text : undefined;
}

/** GitHub's `sha256:<hex>` asset digest, reduced to the bare hexadecimal form. */
export function asGitHubDigest(value: unknown): string | undefined {
  const text = asText(value);
  if (text === undefined || !text.startsWith(GITHUB_DIGEST_PREFIX)) {
    return undefined;
  }
  return asDigest(text.slice(GITHUB_DIGEST_PREFIX.length));
}

/** Parses a document, treating any malformed body as an absent one. */
export function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
