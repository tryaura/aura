/**
 * Reading values back out of unknown data: thrown errors and parsed JSON.
 *
 * These say nothing about any one feature: every module that catches a Node filesystem rejection
 * or narrows a parsed document needs them, so they live in one place rather than accumulating
 * per-directory copies that drift apart.
 */

/** The `errno` code of a Node filesystem failure, when the value is one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows an unknown parsed value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
