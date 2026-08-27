import { isRecord } from "../values.js";

/**
 * Defensive reads over transcript JSON.
 *
 * A transcript line is another application's private state, so nothing about its shape is
 * trusted: every accessor returns `undefined` for anything unexpected instead of throwing.
 */

/** The parsed object of one JSONL line, or undefined for anything that is not one. */
export function parseTranscriptRecord(line: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
