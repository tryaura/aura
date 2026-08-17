import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { createCheckExplanation, createCheckReport } from "./report.js";
import { fixtureAdapter } from "./testing.js";

const schema = JSON.parse(
  readFileSync(new URL("../schema/check-output-v1.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv2020({ allErrors: true }).compile(schema);

describe("check-output-v1.schema.json", () => {
  it("validates the report envelope", () => {
    const report = createCheckReport({
      adapters: [fixtureAdapter(() => ({ installed: false }))],
      apps: [],
      checkDiagnostics: [],
      checks: [],
      findings: [],
      scanDiagnostics: [],
      skipped: [{ adapterId: "fixture", displayName: "Fixture App" }],
      withDetail: false,
    });

    expect(report.apps).toEqual([
      {
        appId: "fixture",
        detection: { installed: false },
        detectionScope: "the fixture CLI on PATH",
        displayName: "Fixture App",
      },
    ]);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates the explanation envelope", () => {
    const explanation = createCheckExplanation({
      defaultSeverity: "warn",
      detect: () => [],
      explain: "Why this matters.\n\nHow to inspect it.",
      fixability: "manual",
      id: "fixture/CHECK",
      scope: "global",
      title: "Fixture check",
    });

    expect(validate(explanation), JSON.stringify(validate.errors)).toBe(true);
  });
});
