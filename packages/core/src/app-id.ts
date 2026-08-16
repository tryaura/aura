/**
 * Well-known user-facing aliases for application adapter IDs.
 *
 * A `Map` rather than an object literal: the keys are whatever a user typed, and an object would
 * answer `constructor` or `__proto__` from its prototype chain — returning something that is not a
 * string from a function that promises one.
 */
const APP_ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ["claude", "claude-code"],
  ["claude_code", "claude-code"],
]);

/** Resolves a typed application selector to its canonical adapter ID. */
export function canonicalAppId(value: string): string {
  const normalized = value.toLowerCase();
  return APP_ID_ALIASES.get(normalized) ?? normalized;
}
