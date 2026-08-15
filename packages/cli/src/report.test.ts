import type { Check, Finding } from "@tryaura/aura-sdk";
import type { ScanDiagnostic } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createCheckReport } from "./report.js";

const CHECK: Check = {
  defaultSeverity: "warn",
  detect: () => [],
  explain: "Test check.",
  fixability: "manual",
  id: "fixture/CHECK",
  scope: "global",
  title: "Fixture check",
};

describe("createCheckReport", () => {
  it("returns zero for clean and informational-only reports", () => {
    expect(createCheckReport([CHECK], [], []).exitCode).toBe(0);
    expect(createCheckReport([CHECK], [finding("info")], []).exitCode).toBe(0);
  });

  it("returns one for warnings and two when any error is present", () => {
    expect(createCheckReport([CHECK], [finding("warn")], []).exitCode).toBe(1);
    expect(createCheckReport([CHECK], [finding("warn"), finding("error")], []).exitCode).toBe(2);
  });

  it("treats scan diagnostics as errors and omits their untrusted detail", () => {
    const diagnostic: ScanDiagnostic = {
      adapterId: "fixture",
      detail: "secret source contents",
      message: "Fixture failed during detect.",
      phase: "detect",
    };

    const report = createCheckReport([CHECK], [], [diagnostic]);

    expect(report.exitCode).toBe(2);
    expect(report.diagnostics).toEqual([
      {
        adapterId: "fixture",
        message: "Fixture failed during detect.",
        phase: "detect",
      },
    ]);
  });

  it("reports checks without findings as passed", () => {
    const report = createCheckReport([CHECK], [], []);

    expect(report.passedChecks).toEqual([{ id: CHECK.id, title: CHECK.title }]);
    expect(report.summary).toEqual({ errors: 0, informational: 0, passed: 1, warnings: 0 });
  });
});

function finding(severity: Finding["severity"]): Finding {
  return {
    checkId: CHECK.id,
    id: severity,
    message: `${severity} finding`,
    scope: CHECK.scope,
    severity,
  };
}
