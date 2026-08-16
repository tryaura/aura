/** Narrows to a plain JSON-shaped object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Freezes a JSON-shaped value all the way down. */
export function deepFreeze<T>(value: T): T {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  for (const property of Object.values(value)) {
    deepFreeze(property);
  }
  return Object.freeze(value);
}
