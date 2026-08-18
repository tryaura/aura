import type { AuraCheckConfiguration, JsonObject, JsonValue, Severity } from "@tryaura/aura-sdk";
import { defineOwnProperty, jsonPropertyPath } from "@tryaura/aura-sdk";

import { invalid, requiredObject, stringArray } from "./schema-values.js";

const CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_CHECK_IDS = 256;

export function optionalPreset(value: JsonValue | undefined): {
  readonly preset?: string | undefined;
} {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid("$.preset", "must be a non-empty preset reference");
  }
  return { preset: value };
}

/**
 * Validates the four recognized check settings, carrying anything else through untouched.
 *
 * Unknown keys survive on purpose, as they do everywhere else in the manifest: the file is written
 * by Aura and read back by whatever version runs next, so a setting a newer release understands
 * must not be destroyed — or rejected — by an older one that does not. Typo protection belongs
 * where a human is authoring by hand, which is the preset schema and the command line, not here.
 */
export function optionalChecks(value: JsonValue | undefined): {
  readonly checks?: AuraCheckConfiguration | undefined;
} {
  if (value === undefined) {
    return {};
  }
  const source = requiredObject(value, "$.checks");
  const enabled = optionalStringArray(source["enabled"], "$.checks.enabled");
  const disabled = optionalStringArray(source["disabled"], "$.checks.disabled");
  const conflicts = new Set(enabled ?? []);
  for (const id of disabled ?? []) {
    if (conflicts.has(id)) {
      throw invalid("$.checks", `must not both enable and disable check ${id}`);
    }
  }
  return {
    checks: Object.freeze({
      ...source,
      ...(disabled === undefined ? {} : { disabled }),
      ...(enabled === undefined ? {} : { enabled }),
      ...optionalSeverity(source["severity"]),
      ...optionalThresholds(source["thresholds"]),
    }),
  };
}

function optionalStringArray(
  value: JsonValue | undefined,
  path: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = stringArray(value, path);
  if (values.length > MAX_CHECK_IDS) {
    throw invalid(path, `must contain at most ${String(MAX_CHECK_IDS)} check IDs`);
  }
  const seen = new Set<string>();
  for (const [index, id] of values.entries()) {
    if (!CHECK_ID_PATTERN.test(id)) {
      throw invalid(`${path}[${String(index)}]`, "must be a valid check ID");
    }
    if (seen.has(id)) {
      throw invalid(`${path}[${String(index)}]`, "must not duplicate another check ID");
    }
    seen.add(id);
  }
  return values;
}

function optionalSeverity(value: JsonValue | undefined): {
  readonly severity?: Readonly<Record<string, Severity>> | undefined;
} {
  if (value === undefined) {
    return {};
  }
  const source = requiredObject(value, "$.checks.severity");
  if (Object.keys(source).length > MAX_CHECK_IDS) {
    throw invalid("$.checks.severity", `must contain at most ${String(MAX_CHECK_IDS)} entries`);
  }
  const result: Record<string, Severity> = {};
  for (const [id, candidate] of Object.entries(source)) {
    if (!CHECK_ID_PATTERN.test(id)) {
      throw invalid(jsonPropertyPath("$.checks.severity", id), "check ID is invalid");
    }
    if (candidate !== "error" && candidate !== "info" && candidate !== "warn") {
      throw invalid(jsonPropertyPath("$.checks.severity", id), "must be error, info, or warn");
    }
    defineOwnProperty(result, id, candidate);
  }
  return { severity: Object.freeze(result) };
}

function optionalThresholds(value: JsonValue | undefined): {
  readonly thresholds?: Readonly<Record<string, JsonObject>> | undefined;
} {
  if (value === undefined) {
    return {};
  }
  const source = requiredObject(value, "$.checks.thresholds");
  if (Object.keys(source).length > MAX_CHECK_IDS) {
    throw invalid("$.checks.thresholds", `must contain at most ${String(MAX_CHECK_IDS)} entries`);
  }
  const result: Record<string, JsonObject> = {};
  for (const [id, candidate] of Object.entries(source)) {
    if (!CHECK_ID_PATTERN.test(id)) {
      throw invalid(jsonPropertyPath("$.checks.thresholds", id), "check ID is invalid");
    }
    defineOwnProperty(
      result,
      id,
      requiredObject(candidate, jsonPropertyPath("$.checks.thresholds", id)),
    );
  }
  return { thresholds: Object.freeze(result) };
}
