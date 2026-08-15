import type { Check, Finding } from "@tryaura/aura-sdk";
import type { ScanDiagnostic } from "@tryaura/core";

import type { CliExitCode } from "./types.js";

interface PassedCheck {
  readonly id: string;
  readonly title: string;
}

interface CheckSummary {
  readonly errors: number;
  readonly informational: number;
  readonly passed: number;
  readonly warnings: number;
}

type ReportDiagnostic = Omit<ScanDiagnostic, "detail">;

export interface CheckReport {
  readonly diagnostics: readonly ReportDiagnostic[];
  readonly exitCode: CliExitCode;
  readonly findings: readonly Finding[];
  readonly passedChecks: readonly PassedCheck[];
  readonly status: "clean" | "error" | "warning";
  readonly summary: CheckSummary;
}

export function createCheckReport(
  checks: readonly Check[],
  findings: readonly Finding[],
  diagnostics: readonly ScanDiagnostic[],
): CheckReport {
  const checkIdsWithFindings = new Set(findings.map((finding) => finding.checkId));
  const passedChecks = checks
    .filter((check) => !checkIdsWithFindings.has(check.id))
    .map((check) => Object.freeze({ id: check.id, title: check.title }));
  const summary: CheckSummary = Object.freeze({
    errors: countSeverity(findings, "error"),
    informational: countSeverity(findings, "info"),
    passed: passedChecks.length,
    warnings: countSeverity(findings, "warn"),
  });
  const exitCode = resolveExitCode(summary, diagnostics);
  const reportDiagnostics = diagnostics.map((diagnostic) =>
    Object.freeze({
      adapterId: diagnostic.adapterId,
      message: diagnostic.message,
      phase: diagnostic.phase,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    }),
  );

  return Object.freeze({
    diagnostics: Object.freeze(reportDiagnostics),
    exitCode,
    findings,
    passedChecks: Object.freeze(passedChecks),
    status: exitCode === 2 ? "error" : exitCode === 1 ? "warning" : "clean",
    summary,
  });
}

function countSeverity(findings: readonly Finding[], severity: Finding["severity"]): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

function resolveExitCode(
  summary: CheckSummary,
  diagnostics: readonly ScanDiagnostic[],
): CliExitCode {
  if (summary.errors > 0 || diagnostics.length > 0) {
    return 2;
  }
  if (summary.warnings > 0) {
    return 1;
  }
  return 0;
}
