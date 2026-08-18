import type { AuraCheckConfiguration, JsonObject, JsonValue, Severity } from "@tryaura/aura-sdk";
import { defineOwnProperty, jsonPropertyPath } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import {
  collectIds,
  CHECK_ID_PATTERN,
  firstProblem,
  MAX_JSON_DEPTH,
  MAX_SELECTIONS,
  type JsonParseResult,
} from "./schema-common.js";

// fallow-ignore-next-line complexity -- validates the four independent fields of the check object.
export function collectChecks(value: unknown): AuraCheckConfiguration | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return "$.checks: must be an object";
  }
  const enabled = collectIds(value["enabled"], "$.checks.enabled", CHECK_ID_PATTERN);
  const disabled = collectIds(value["disabled"], "$.checks.disabled", CHECK_ID_PATTERN);
  const severity = collectSeverity(value["severity"]);
  const thresholds = collectThresholds(value["thresholds"]);
  const problem = firstProblem([enabled, disabled, severity, thresholds]);
  if (problem !== undefined) {
    return problem;
  }
  if (Array.isArray(enabled) && Array.isArray(disabled)) {
    const enabledIds = new Set(enabled);
    const conflict = disabled.find((id) => enabledIds.has(id));
    if (conflict !== undefined) {
      return `$.checks: must not both enable and disable check ${conflict}`;
    }
  }
  return Object.freeze({
    ...(Array.isArray(disabled) ? { disabled } : {}),
    ...(Array.isArray(enabled) ? { enabled } : {}),
    ...(isSeverityMap(severity) ? { severity } : {}),
    ...(isThresholdMap(thresholds) ? { thresholds } : {}),
  });
}

export function isChecks(value: unknown): value is AuraCheckConfiguration {
  return isRecord(value) && !Array.isArray(value);
}

function collectSeverity(value: unknown): Readonly<Record<string, Severity>> | string | undefined {
  const source = collectBoundedRecord(value, "$.checks.severity");
  if (typeof source === "string" || source === undefined) {
    return source;
  }
  const result: Record<string, Severity> = {};
  for (const [id, candidate] of Object.entries(source)) {
    const path = jsonPropertyPath("$.checks.severity", id);
    if (!CHECK_ID_PATTERN.test(id)) {
      return `${path}: check id is invalid`;
    }
    if (candidate !== "error" && candidate !== "info" && candidate !== "warn") {
      return `${path}: must be error, info, or warn`;
    }
    defineOwnProperty(result, id, candidate);
  }
  return Object.freeze(result);
}

function isSeverityMap(value: unknown): value is Readonly<Record<string, Severity>> {
  return isRecord(value) && !Array.isArray(value);
}

function collectThresholds(
  value: unknown,
): Readonly<Record<string, JsonObject>> | string | undefined {
  const source = collectBoundedRecord(value, "$.checks.thresholds");
  if (typeof source === "string" || source === undefined) {
    return source;
  }
  const result: Record<string, JsonObject> = {};
  for (const [id, candidate] of Object.entries(source)) {
    const path = jsonPropertyPath("$.checks.thresholds", id);
    if (!CHECK_ID_PATTERN.test(id)) {
      return `${path}: check id is invalid`;
    }
    const parsed = collectJsonObject(candidate, path, 0);
    if (parsed.status === "invalid") {
      return parsed.problem;
    }
    defineOwnProperty(result, id, parsed.value);
  }
  return Object.freeze(result);
}

function collectBoundedRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return `${path}: must be an object`;
  }
  return Object.keys(value).length > MAX_SELECTIONS
    ? `${path}: must contain at most ${String(MAX_SELECTIONS)} entries`
    : value;
}

function isThresholdMap(value: unknown): value is Readonly<Record<string, JsonObject>> {
  return isRecord(value) && !Array.isArray(value);
}

function collectJsonObject(
  value: unknown,
  path: string,
  depth: number,
): JsonParseResult<JsonObject> {
  if (!isRecord(value)) {
    return { problem: `${path}: must be an object`, status: "invalid" };
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const childPath = jsonPropertyPath(path, key);
    const parsed = collectJsonValue(candidate, childPath, depth + 1);
    if (parsed.status === "invalid") {
      return parsed;
    }
    defineOwnProperty(result, key, parsed.value);
  }
  return { status: "valid", value: Object.freeze(result) };
}

// fallow-ignore-next-line complexity -- recursively normalizes every JSON primitive and container kind.
// fallow-ignore-next-line complexity -- recursively normalizes every JSON primitive and container kind.
function collectJsonValue(value: unknown, path: string, depth: number): JsonParseResult<JsonValue> {
  if (depth > MAX_JSON_DEPTH) {
    return {
      problem: `${path}: is nested deeper than the ${String(MAX_JSON_DEPTH)} level limit`,
      status: "invalid",
    };
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { status: "valid", value };
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, candidate] of value.entries()) {
      const parsed = collectJsonValue(candidate, `${path}[${String(index)}]`, depth + 1);
      if (parsed.status === "invalid") {
        return parsed;
      }
      result.push(parsed.value);
    }
    return { status: "valid", value: Object.freeze(result) };
  }
  return collectJsonObject(value, path, depth);
}
