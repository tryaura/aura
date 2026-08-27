/** Upper bounds for numeric values read from untrusted transcript records. */
export const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_MCP_SECONDS = MAX_DURATION_MS / 1000;
export const MAX_NANOSECONDS = 999_999_999;
export const MAX_TOKEN_COUNT = 10_000_000_000;
export const MAX_CONTEXT_WINDOW = 1_000_000_000;
export const MAX_QUOTA_WINDOW_MINUTES = 10 * 366 * 24 * 60;

interface InvalidValueCounter {
  invalidValues: number;
}

/** Reads a bounded non-negative integer and records present-but-invalid input. */
export function readBoundedInteger(
  state: InvalidValueCounter,
  value: unknown,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum) {
    return value;
  }
  state.invalidValues += 1;
  return undefined;
}

/** Reads a percentage in the inclusive 0–100 range. */
export function readPercentage(state: InvalidValueCounter, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) {
    return value;
  }
  state.invalidValues += 1;
  return undefined;
}

/** Adds non-negative metrics without allowing an aggregate to become unsafe or non-finite. */
export function boundedAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

export function boundedSum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total = boundedAdd(total, value);
  }
  return total;
}
