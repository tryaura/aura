/**
 * Whether a name or a bare value looks like a credential.
 *
 * Two audiences read these predicates and they tolerate mistakes in opposite directions. Detection
 * and redaction want a wide net: a false positive costs a `[redacted]` on something harmless.
 * Validation wants a narrow one: a false positive rejects a manifest the user wrote correctly. The
 * split lives here so a caller has to choose, rather than inheriting whichever net moved last.
 */

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const SECRET_NAME_PATTERN =
  /(?:^|[-_])(?:api[-_]?keys?|keys?|secrets?|tokens?|passwords?|passwd|pwd|auth(?:orization)?|credentials?|bearer)$/iu;
const SECRET_VALUE_PATTERN =
  /^(?:sk|pk|rk)[-_]|^(?:gh[opsur]|github_pat)_|^xox[abpsr]-|^AKIA[0-9A-Z]{16}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

/** The shortest bare value the entropy test will look at. */
const MIN_ENTROPY_LENGTH = 32;

/**
 * A value with no structure a human would have written into it.
 *
 * Entropy alone cannot separate a credential from an ordinary long string: a filesystem path and a
 * random token measure about the same, because a path's variety comes from words rather than from
 * randomness. Requiring a single opaque run of token characters is what excludes paths, URLs,
 * package specifiers, and prose before entropy is consulted at all.
 */
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_.~+=-]+$/u;

/** Hexadecimal long enough to be an issued key, once UUIDs and Git object ids are excluded. */
const HEX_SECRET_PATTERN = /^[0-9a-f]{32,}$/iu;

/** Below this many distinct digits, a hex run is a repeated pattern rather than a key. */
const MIN_HEX_ALPHABET = 8;

/** Whether a name is a valid POSIX environment variable name. */
export function isEnvironmentVariableName(name: string): boolean {
  return ENV_NAME_PATTERN.test(name);
}

/** Whether a field name conventionally carries credentials. */
export function isMcpSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name.replace(/^-+/u, ""));
}

/**
 * Whether a value announces itself as a credential through a vendor's issued prefix.
 *
 * This is the narrow net. It only matches shapes no legitimate configuration value takes, which is
 * what makes it safe to reject a manifest over.
 */
export function hasMcpSecretPrefix(value: string): boolean {
  return SECRET_VALUE_PATTERN.test(value);
}

/**
 * Whether a bare literal looks credential-like without relying on its field name.
 *
 * This is the wide net. Shape is tested before entropy because entropy on its own points the wrong
 * way twice: a filesystem path scores above the threshold while a hex-encoded key cannot reach it
 * at all, since hexadecimal carries at most 4 bits per character. Restricting the entropy test to
 * one opaque token drops the paths, and giving long hex its own rule recovers the keys — Git object
 * ids and UUIDs having already been excluded above as the two hex shapes that are not credentials.
 */
export function isMcpSecretValue(value: string): boolean {
  if (UUID_PATTERN.test(value) || GIT_SHA_PATTERN.test(value)) {
    return false;
  }
  if (hasMcpSecretPrefix(value)) {
    return true;
  }
  if (value.length < MIN_ENTROPY_LENGTH || !OPAQUE_TOKEN_PATTERN.test(value)) {
    return false;
  }
  if (HEX_SECRET_PATTERN.test(value)) {
    return new Set(value.toLowerCase()).size >= MIN_HEX_ALPHABET;
  }
  return shannonEntropy(value) > 4;
}

/** Shannon entropy in bits per character. */
function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** Whether a value is entirely environment references plus a scheme the application supplies. */
export function isEnvironmentReference(value: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  const stripped = value
    .replaceAll(pattern, "")
    .replace(/^\s*bearer\b/iu, "")
    .trim();
  pattern.lastIndex = 0;
  return stripped.length === 0;
}
