import type { Adapter, Check, Finding } from "@tryaura/aura-sdk";
import type { CheckDiagnostic, ScanDiagnostic } from "@tryaura/core";
import { describe, expect, it } from "vitest";

import { createCheckReport, type CheckReportInput } from "./report.js";

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
  it("returns zero for every completed report regardless of finding severity", () => {
    expect(report().summary.exitCode).toBe(0);
    expect(report({ findings: [finding("info")] }).summary.exitCode).toBe(0);
    expect(report({ findings: [finding("warn")] })).toMatchObject({
      status: "warning",
      summary: { exitCode: 0 },
    });
    expect(report({ findings: [finding("warn"), finding("error")] })).toMatchObject({
      status: "error",
      summary: { exitCode: 0 },
    });
  });

  it("preserves a forced failure exit code after producing a report", () => {
    expect(report({ findings: [finding("error")], forcedExitCode: 2 })).toMatchObject({
      status: "error",
      summary: { exitCode: 2 },
    });
  });

  it("supports setup's finding-sensitive end-on-green report", () => {
    expect(
      report({ findings: [finding("warn")], findingsAffectExitCode: true }).summary.exitCode,
    ).toBe(1);
    expect(
      report({ findings: [finding("error")], findingsAffectExitCode: true }).summary.exitCode,
    ).toBe(2);
  });

  it("treats scan diagnostics as errors and omits their untrusted detail", () => {
    const result = report({ scanDiagnostics: [scanDiagnostic()] });

    expect(result.summary.exitCode).toBe(3);
    expect(result.diagnostics).toEqual([
      { id: "fixture", message: "Fixture failed during detect.", phase: "detect" },
    ]);
  });

  it("gives diagnostics precedence over finding and conflict exit codes", () => {
    expect(
      report({
        findings: [finding("error")],
        forcedExitCode: 2,
        scanDiagnostics: [scanDiagnostic()],
      }).summary.exitCode,
    ).toBe(3);
  });

  it("treats a check that could not run as an error without reporting it as passed", () => {
    const result = report({ checkDiagnostics: [checkDiagnostic()] });

    expect(result.summary.exitCode).toBe(3);
    expect(result.diagnostics).toEqual([
      { id: "fixture/CHECK", message: "Fixture check failed and was skipped.", phase: "check" },
    ]);
    expect(result.passedChecks).toEqual([]);
    expect(result.summary.passed).toBe(0);
  });

  it("carries untrusted detail only when it was asked for", () => {
    const result = report({
      checkDiagnostics: [checkDiagnostic()],
      scanDiagnostics: [scanDiagnostic()],
      withDetail: true,
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.detail)).toEqual([
      "secret source contents",
      "secret source contents",
    ]);
  });

  it("reports checks without findings as passed", () => {
    const result = report();

    expect(result.passedChecks).toEqual([{ id: CHECK.id, title: CHECK.title }]);
    expect(result.summary).toEqual({
      categories: {
        CHECK: { errors: 0, informational: 0, passed: 1, warnings: 0 },
      },
      diagnostics: 0,
      errors: 0,
      exitCode: 0,
      informational: 0,
      passed: 1,
      warnings: 0,
    });
    expect(result.status).toBe("clean");
  });

  it("does not call a run that had no checks to run clean", () => {
    expect(report({ checks: [] }).status).toBe("empty");
    expect(report({ checks: [] }).summary.exitCode).toBe(2);
  });

  it("carries every real selected application even when detection failed", () => {
    expect(report({ adapters: [adapter()] }).apps).toEqual([
      { appId: "cursor", detection: { installed: false }, displayName: "Cursor" },
    ]);
  });

  it("carries the detection scope of an application the scan looked for and skipped", () => {
    const scoped = { ...adapter(), detectionScope: "the cursor shell command on PATH" };

    expect(
      report({
        adapters: [scoped],
        skipped: [{ adapterId: "cursor", displayName: "Cursor" }],
      }).apps,
    ).toEqual([
      {
        appId: "cursor",
        detection: { installed: false },
        detectionScope: "the cursor shell command on PATH",
        displayName: "Cursor",
      },
    ]);
  });

  // A crashed adapter is absent from both `apps` and `skipped`. Its scope describes a probe that
  // never ran, so repeating it would contradict the diagnostic the same run prints.
  it("drops the detection scope of an adapter that never reported a result", () => {
    const scoped = { ...adapter(), detectionScope: "the cursor shell command on PATH" };

    expect(report({ adapters: [scoped] }).apps).toEqual([
      { appId: "cursor", detection: { installed: false }, displayName: "Cursor" },
    ]);
  });

  it("omits synthetic inventory adapters", () => {
    expect(report({ adapters: [{ ...adapter(), synthetic: true }] }).apps).toEqual([]);
  });
});

function report(overrides: Partial<CheckReportInput> = {}): ReturnType<typeof createCheckReport> {
  return createCheckReport({
    adapters: [],
    apps: [],
    checkDiagnostics: [],
    checks: [CHECK],
    findings: [],
    scanDiagnostics: [],
    skipped: [],
    withDetail: false,
    ...overrides,
  });
}

function adapter(): Adapter {
  return {
    detect: async () => ({ installed: false }),
    displayName: "Cursor",
    files: () => [],
    id: "cursor",
    parse: () => ({ instructionFiles: [], mcpServers: [], skills: [] }),
    supportedRange: ">=1",
  };
}

function scanDiagnostic(): ScanDiagnostic {
  return {
    adapterId: "fixture",
    detail: "secret source contents",
    message: "Fixture failed during detect.",
    phase: "detect",
  };
}

function checkDiagnostic(): CheckDiagnostic {
  return {
    checkId: CHECK.id,
    detail: "secret source contents",
    message: "Fixture check failed and was skipped.",
  };
}

function finding(severity: Finding["severity"]): Finding {
  return {
    checkId: CHECK.id,
    id: severity,
    message: `${severity} finding`,
    scope: CHECK.scope,
    severity,
  };
}
