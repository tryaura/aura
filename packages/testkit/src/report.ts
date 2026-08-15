import type { CheckReport } from "@tryaura/aura-cli";
import type { JsonObject, JsonValue } from "@tryaura/aura-sdk";

import { isRecord } from "./guards.js";

/**
 * Reads the whole `check --json` document.
 *
 * The parsed value is returned as it arrived rather than rebuilt field by field, so a field the
 * report grows later reaches the test that snapshots it instead of being silently dropped by a
 * copier that predates it. Validation only proves the fields this package promises are present and
 * well-formed.
 */
export function parseReport(stdout: string, fail: (message: string) => Error): CheckReport {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw fail("Check runner expected one JSON report on stdout.");
  }

  const problems: string[] = [];
  if (!isCheckReport(document, problems)) {
    throw fail(
      ["Check runner received a JSON report it cannot read:", ...problems.map(indent)].join("\n"),
    );
  }
  return deepFreeze(document);
}

function indent(problem: string): string {
  return `  - ${problem}`;
}

type FieldCheck = (value: unknown, path: string, problems: string[]) => boolean;

function isCheckReport(value: unknown, problems: string[]): value is CheckReport {
  return shape(REPORT)(value, "report", problems);
}

function reject(path: string, expectation: string, problems: string[]): false {
  problems.push(`${path}: expected ${expectation}`);
  return false;
}

/** Validates the declared keys and ignores every other one, which is what lets the report grow. */
function shape(fields: Readonly<Record<string, FieldCheck>>): FieldCheck {
  return (value, path, problems) => {
    if (!isRecord(value)) {
      return reject(path, "an object", problems);
    }

    let valid = true;
    for (const [key, check] of Object.entries(fields)) {
      valid = check(value[key], `${path}.${key}`, problems) && valid;
    }
    return valid;
  };
}

function arrayOf(check: FieldCheck): FieldCheck {
  return (value, path, problems) => {
    if (!Array.isArray(value)) {
      return reject(path, "an array", problems);
    }

    let valid = true;
    for (const [index, element] of value.entries()) {
      valid = check(element, `${path}[${String(index)}]`, problems) && valid;
    }
    return valid;
  };
}

function optional(check: FieldCheck): FieldCheck {
  return (value, path, problems) => value === undefined || check(value, path, problems);
}

function oneOf(...allowed: readonly (number | string)[]): FieldCheck {
  const expectation = `one of ${allowed.map((option) => JSON.stringify(option)).join(", ")}`;
  return (value, path, problems) =>
    allowed.some((option) => option === value) || reject(path, expectation, problems);
}

const text: FieldCheck = (value, path, problems) =>
  typeof value === "string" || reject(path, "a string", problems);

const counter: FieldCheck = (value, path, problems) =>
  (typeof value === "number" && Number.isInteger(value) && value >= 0) ||
  reject(path, "a count", problems);

const position: FieldCheck = (value, path, problems) =>
  (typeof value === "number" && Number.isInteger(value) && value > 0) ||
  reject(path, "a 1-based position", problems);

const jsonObject: FieldCheck = (value, path, problems) =>
  isJsonObject(value) || reject(path, "a JSON object", problems);

const location = shape({
  column: optional(position),
  line: optional(position),
  path: text,
});

const finding = shape({
  checkId: text,
  details: optional(text),
  id: text,
  locations: optional(arrayOf(location)),
  message: text,
  metadata: optional(jsonObject),
  scope: oneOf("global", "project"),
  severity: oneOf("error", "info", "warn"),
});

const REPORT: Readonly<Record<string, FieldCheck>> = {
  diagnostics: arrayOf(
    shape({
      detail: optional(text),
      id: text,
      message: text,
      path: optional(text),
      phase: oneOf("check", "detect", "files", "parse", "read", "support"),
    }),
  ),
  exitCode: oneOf(0, 1, 2),
  findings: arrayOf(finding),
  passedChecks: arrayOf(shape({ id: text, title: text })),
  skipped: arrayOf(shape({ adapterId: text, displayName: text })),
  status: oneOf("clean", "empty", "error", "warning"),
  summary: shape({
    errors: counter,
    informational: counter,
    passed: counter,
    warnings: counter,
  }),
};

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    isJsonObject(value)
  );
}

/** Freezes the report all the way down, so one test cannot edit what the next one asserts on. */
function deepFreeze<T>(value: T): T {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  for (const property of Object.values(value)) {
    deepFreeze(property);
  }
  return Object.freeze(value);
}
