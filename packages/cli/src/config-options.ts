import type { AuraConfigurationLayer, JsonObject, JsonValue, Severity } from "@tryaura/aura-sdk";
import { defineOwnProperty } from "@tryaura/aura-sdk";
import { Option } from "clipanion/lib/advanced/index.js";

const MAX_ECHOED_CHARACTERS = 60;
const MAX_JSON_DEPTH = 100;
const MAX_THRESHOLD_CHARACTERS = 256_000;

export function disableOption() {
  return Option.Array("--disable", [], {
    description: "Disable one check for this run. Repeatable.",
  });
}

export function enableOption() {
  return Option.Array("--enable", [], {
    description: "Enable one check for this run. Repeatable.",
  });
}

export function noCacheOption() {
  return Option.Boolean("--no-cache", false, {
    description: "Bypass runtime preset cache reads and writes.",
  });
}

export function presetOption() {
  return Option.String("--preset", {
    description: "Load a bundled, npm, HTTPS, or local team preset.",
  });
}

export function severityOption() {
  return Option.Array("--severity", [], {
    description: "Override severity as <check>=<error|info|warn>. Repeatable.",
  });
}

export function thresholdOption() {
  return Option.Array("--threshold", [], {
    description: "Override thresholds as <check>=<JSON object>. Repeatable.",
  });
}

interface ConfigurationFlagValues {
  readonly disabled: readonly string[];
  readonly enabled: readonly string[];
  readonly severity: readonly string[];
  readonly thresholds: readonly string[];
}

export type ConfigurationFlagResult =
  | { readonly layer: AuraConfigurationLayer; readonly status: "ready" }
  | { readonly message: string; readonly status: "invalid" };

export function parseConfigurationFlagArrays(
  disabled: readonly string[],
  enabled: readonly string[],
  severity: readonly string[],
  thresholds: readonly string[],
): ConfigurationFlagResult {
  return parseConfigurationFlags({ disabled, enabled, severity, thresholds });
}

/** Parses repeatable check flags into the same inert layer shape used by presets and manifests. */
function parseConfigurationFlags(values: ConfigurationFlagValues): ConfigurationFlagResult {
  const enabled = unique(values.enabled);
  const disabled = unique(values.disabled);
  const conflict = disabled.find((id) => enabled.includes(id));
  if (conflict !== undefined) {
    return invalid(`--enable and --disable both name ${conflict}. Choose one.`);
  }
  const severity = parseSeverity(values.severity);
  if (typeof severity === "string") {
    return invalid(severity);
  }
  const thresholds = parseThresholds(values.thresholds);
  if (typeof thresholds === "string") {
    return invalid(thresholds);
  }
  return {
    layer: Object.freeze({
      checks: Object.freeze({
        ...(disabled.length === 0 ? {} : { disabled: Object.freeze(disabled) }),
        ...(enabled.length === 0 ? {} : { enabled: Object.freeze(enabled) }),
        ...(Object.keys(severity).length === 0 ? {} : { severity: Object.freeze(severity) }),
        ...(Object.keys(thresholds).length === 0 ? {} : { thresholds: Object.freeze(thresholds) }),
      }),
    }),
    status: "ready",
  };
}

function parseSeverity(values: readonly string[]): Record<string, Severity> | string {
  const result: Record<string, Severity> = {};
  for (const value of values) {
    const pair = splitAssignment(value);
    if (
      pair === undefined ||
      (pair.value !== "error" && pair.value !== "info" && pair.value !== "warn")
    ) {
      return `--severity ${quote(value)} is not valid. Expected <check>=<error|info|warn>.`;
    }
    defineOwnProperty(result, pair.id, pair.value);
  }
  return result;
}

function parseThresholds(values: readonly string[]): Record<string, JsonObject> | string {
  const result: Record<string, JsonObject> = {};
  for (const value of values) {
    const pair = splitAssignment(value);
    if (pair === undefined) {
      return `--threshold ${quote(value)} is not valid. Expected <check>=<JSON object>.`;
    }
    if (pair.value.length > MAX_THRESHOLD_CHARACTERS) {
      return `--threshold for ${pair.id} is larger than the ${String(MAX_THRESHOLD_CHARACTERS)} character limit.`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(pair.value);
    } catch (error) {
      return `--threshold for ${pair.id} is not valid JSON: ${describeJsonError(error)}.`;
    }
    const object = normalizeJsonObject(parsed, 0);
    if (object === undefined) {
      return `--threshold for ${pair.id} must be a JSON object nested at most ${String(MAX_JSON_DEPTH)} levels deep, with finite numbers only.`;
    }
    defineOwnProperty(result, pair.id, object);
  }
  return result;
}

/**
 * Quotes one rejected argument, shortened so a pasted document cannot bury the message.
 *
 * These flags repeat, so naming the value is the only thing that tells the user which of several
 * occurrences to go fix.
 */
function quote(value: string): string {
  const shown =
    value.length > MAX_ECHOED_CHARACTERS ? `${value.slice(0, MAX_ECHOED_CHARACTERS)}…` : value;
  return `"${shown}"`;
}

function describeJsonError(error: unknown): string {
  return error instanceof Error ? error.message : "could not be parsed";
}

interface Assignment {
  readonly id: string;
  readonly value: string;
}

function splitAssignment(value: string): Assignment | undefined {
  const separator = value.indexOf("=");
  const id = value.slice(0, separator);
  return separator <= 0 || id.trim() === "" ? undefined : { id, value: value.slice(separator + 1) };
}

function normalizeJsonObject(value: unknown, depth: number): JsonObject | undefined {
  if (!isRecord(value) || depth > MAX_JSON_DEPTH) {
    return undefined;
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const normalized = normalizeJsonValue(candidate, depth + 1);
    if (normalized === undefined) {
      return undefined;
    }
    defineOwnProperty(result, key, normalized);
  }
  return Object.freeze(result);
}

// fallow-ignore-next-line complexity -- recursively normalizes every JSON primitive and container kind.
function normalizeJsonValue(value: unknown, depth: number): JsonValue | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const candidate of value) {
      const normalized = normalizeJsonValue(candidate, depth + 1);
      if (normalized === undefined) {
        return undefined;
      }
      result.push(normalized);
    }
    return Object.freeze(result);
  }
  return normalizeJsonObject(value, depth);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function invalid(message: string): ConfigurationFlagResult {
  return { message, status: "invalid" };
}
