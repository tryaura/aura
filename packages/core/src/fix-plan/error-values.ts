/**
 * Reading values back out of an unknown thrown thing.
 *
 * Separate from the fix-plan error types because these say nothing about fix plans: every module
 * that catches a Node filesystem rejection needs them, including the ones that build the errors
 * `types.ts` defines.
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
