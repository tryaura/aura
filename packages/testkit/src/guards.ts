/** Narrows to a plain JSON-shaped object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
