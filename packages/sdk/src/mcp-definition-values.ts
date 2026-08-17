import type { McpDefinitionError, McpDefinitionResult } from "./mcp-definition-types.js";

/** Addresses one property in a JSON error path, bracketing anything not a plain identifier. */
const JSON_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** An `${UPPER_SNAKE}` interpolation, the only way a credential may be named in a stored value. */
export const VARIABLE_REFERENCE_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/gu;

/** Every environment-variable name `value` interpolates, in the order they appear. */
export function variableReferences(value: string): readonly string[] {
  return [...value.matchAll(VARIABLE_REFERENCE_PATTERN)].flatMap((match) => {
    const name = match[1];
    return name === undefined ? [] : [name];
  });
}

export function requiredNonemptyString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): McpDefinitionResult<string> {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? { value: candidate }
    : failure(`${path}.${key}`, "must be a non-empty string");
}

/**
 * Reads an absolute HTTP(S) URL, rejecting the userinfo form.
 *
 * `https://user:token@host` puts a credential in a field that survives every later redaction pass,
 * so the shape is refused rather than sanitized: a URL Aura stores is one it can hand to an
 * application verbatim.
 */
export function httpUrl(value: unknown, path: string): McpDefinitionResult<string> {
  if (typeof value !== "string") {
    return failure(path, "must be an absolute HTTP(S) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return failure(path, "must be an absolute HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    return failure(path, "must be an absolute HTTP(S) URL without embedded credentials");
  }
  return { value };
}

export function optionalStringArray(
  value: unknown,
  path: string,
): McpDefinitionResult<readonly string[] | undefined> {
  if (value === undefined) {
    return { value: undefined };
  }
  if (!Array.isArray(value)) {
    return failure(path, "must be an array");
  }
  const result: string[] = [];
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== "string") {
      return failure(`${path}[${String(index)}]`, "must be a string");
    }
    result.push(candidate);
  }
  return { value: Object.freeze(result) };
}

export function hasError<T>(
  result: McpDefinitionResult<T>,
): result is { readonly error: McpDefinitionError } {
  return "error" in result;
}

export function failure(path: string, message: string): { readonly error: McpDefinitionError } {
  return { error: Object.freeze({ message, path }) };
}

export function isMcpDefinitionRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonPropertyPath(parent: string, key: string): string {
  return JSON_IDENTIFIER_PATTERN.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Adds one key without letting the parsed document decide what the object inherits.
 *
 * `JSON.parse` reports `__proto__` as an ordinary own property, but plain assignment routes that
 * one key through the inherited setter: the field would vanish from what Aura stores, and its
 * value would become the object's prototype. Defining the property does neither.
 */
export function defineOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
