/** Shared grammar and bounds for the preset-v1 validation walk. */

export const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
export const CONTENT_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;
export const DIRECTORY_PREFIX = "directory:";
export const MAX_JSON_DEPTH = 100;
/** Namespaced MCP catalog id, such as `official/github`. */
export const MCP_CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
export const MAX_SELECTIONS = 256;
export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const SKILL_SOURCE_ID_PATTERN = /^(?:directory|driver|plugin):[^\s:]+$/u;

export type JsonParseResult<T> =
  | { readonly problem: string; readonly status: "invalid" }
  | { readonly status: "valid"; readonly value: T };

/**
 * Picks the first collected problem out of a batch of independently validated fields.
 *
 * Each collector returns either its parsed value or a `$`-rooted path describing what was wrong,
 * so a problem is recognized by that leading `$` rather than by the collector reporting it.
 */
export function firstProblem(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.startsWith("$")) {
      return value;
    }
  }
  return undefined;
}

/** Collects one bounded array of unique ids matching the caller's grammar. */
export function collectIds(
  value: unknown,
  path: string,
  pattern: RegExp,
): readonly string[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return `${path}: must be an array of ids`;
  }
  if (value.length > MAX_SELECTIONS) {
    return `${path}: must contain at most ${String(MAX_SELECTIONS)} ids`;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const itemPath = `${path}[${String(index)}]`;
    if (typeof candidate !== "string" || !pattern.test(candidate)) {
      return `${itemPath}: must be a valid id`;
    }
    if (seen.has(candidate)) {
      return `${itemPath}: must not duplicate another id`;
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return Object.freeze(result);
}
