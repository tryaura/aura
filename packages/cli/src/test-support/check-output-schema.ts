import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";

import type { CheckExplanation, CheckReport } from "../report.js";

type CheckOutput = CheckExplanation | CheckReport;

const parsedSchema: unknown = JSON.parse(
  readFileSync(new URL("../../schema/check-output-v1.schema.json", import.meta.url), "utf8"),
);
if (!isRecord(parsedSchema)) {
  throw new Error("check-output-v1.schema.json must contain a JSON object");
}
const validate = new Ajv2020({ allErrors: true }).compile(parsedSchema);

/** Parses one CLI document only after proving it still conforms to the frozen report schema. */
export function parseCheckReport(source: string): CheckReport {
  const document = parseCheckOutput(source);
  if (document.kind !== "check-report") {
    throw new Error(`Expected a check report, received ${document.kind}`);
  }
  return document;
}

/** Parses one explanation only after proving it still conforms to the frozen report schema. */
export function parseCheckExplanation(source: string): CheckExplanation {
  const document = parseCheckOutput(source);
  if (document.kind !== "check-explanation") {
    throw new Error(`Expected a check explanation, received ${document.kind}`);
  }
  return document;
}

export function assertValidCheckOutput(document: unknown): asserts document is CheckOutput {
  if (!validate(document)) {
    throw new Error(`check output does not match v1 schema: ${JSON.stringify(validate.errors)}`);
  }
}

function parseCheckOutput(source: string): CheckOutput {
  const document: unknown = JSON.parse(source);
  assertValidCheckOutput(document);
  return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
