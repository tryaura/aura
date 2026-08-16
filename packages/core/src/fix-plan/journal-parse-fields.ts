import type { JournalStatus } from "./journal-schema.js";
import { FixPlanError } from "./types.js";

export function parseStatus(value: unknown, path: string): JournalStatus {
  if (value === "aborted" || value === "applied" || value === "pending" || value === "undone") {
    return value;
  }
  throw corrupt(path, `invalid journal status: ${String(value)}`);
}

export function requiredString(value: Record<string, unknown>, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw corrupt(path, `${key} must be a string`);
  }
  return field;
}

export function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const field = value[key];
  if (field !== undefined && typeof field !== "string") {
    throw corrupt(path, `${key} must be a string when present`);
  }
  return field;
}

export function requiredNumber(value: Record<string, unknown>, key: string, path: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw corrupt(path, `${key} must be a finite number`);
  }
  return field;
}

export function requiredBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw corrupt(path, `${key} must be a boolean`);
  }
  return field;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function corrupt(path: string, message: string, cause?: unknown): FixPlanError {
  return new FixPlanError("journal-corrupt", `${message}: ${path}`, { cause, path });
}
