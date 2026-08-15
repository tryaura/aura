import { describe, expect, it } from "vitest";

import { parseReport } from "./report.js";

const fail = (message: string): Error => new Error(message);

const VALID = {
  diagnostics: [],
  exitCode: 1,
  findings: [
    {
      checkId: "fixture/CONFIG",
      id: "legacy-config",
      locations: [{ line: 1, path: "<HOME>/.fixture/config.txt" }],
      message: "Fixture Agent uses its legacy configuration.",
      scope: "global",
      severity: "warn",
    },
  ],
  passedChecks: [],
  skipped: [],
  status: "warning",
  summary: { errors: 0, informational: 0, passed: 0, warnings: 1 },
};

function parse(document: unknown): ReturnType<typeof parseReport> {
  return parseReport(JSON.stringify(document), fail);
}

describe("parseReport", () => {
  it("keeps every field the report carried, including ones it does not know", () => {
    const report = parse({ ...VALID, futureField: { added: "later" } });

    expect(report.findings[0]?.message).toBe("Fixture Agent uses its legacy configuration.");
    expect(report.summary.warnings).toBe(1);
    expect(report).toHaveProperty("futureField", { added: "later" });
  });

  it("freezes the whole document", () => {
    const report = parse(VALID);

    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
    expect(Object.isFrozen(report.findings[0])).toBe(true);
    expect(Object.isFrozen(report.summary)).toBe(true);
  });

  it("names the field and the value it expected", () => {
    expect(() =>
      parse({
        ...VALID,
        findings: [{ ...VALID.findings[0], scope: "everywhere", severity: "fatal" }],
      }),
    ).toThrow(`report.findings[0].scope: expected one of "global", "project"`);
    expect(() => parse({ ...VALID, summary: { ...VALID.summary, warnings: -1 } })).toThrow(
      "report.summary.warnings: expected a count",
    );
    expect(() => parse({ ...VALID, findings: {} })).toThrow("report.findings: expected an array");
    expect(() => parse({ ...VALID, status: "fine" })).toThrow("report.status: expected one of");
  });

  it("reports every problem at once rather than only the first", () => {
    expect(() => parse({ ...VALID, exitCode: 7, status: "fine" })).toThrow(
      /report\.exitCode[\S\s]*report\.status/u,
    );
  });

  it("rejects a location that is not a real position", () => {
    expect(() =>
      parse({
        ...VALID,
        findings: [{ ...VALID.findings[0], locations: [{ line: 0, path: "x" }] }],
      }),
    ).toThrow("report.findings[0].locations[0].line: expected a 1-based position");
  });

  it("accepts a finding without its optional fields", () => {
    const report = parse({
      ...VALID,
      findings: [
        {
          checkId: "fixture/CONFIG",
          id: "legacy-config",
          message: "m",
          scope: "project",
          severity: "info",
        },
      ],
    });

    expect(report.findings[0]?.locations).toBeUndefined();
  });

  it("explains that stdout held no report at all", () => {
    expect(() => parseReport("", fail)).toThrow("Check runner expected one JSON report on stdout.");
    expect(() => parseReport("[]", fail)).toThrow("report: expected an object");
  });
});
