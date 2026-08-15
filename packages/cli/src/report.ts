import type { Check, Finding } from "@tryaura/aura-sdk";
import type { CheckDiagnostic, ScanDiagnostic, ScanPhase, SkippedApp } from "@tryaura/core";

import type { CliExitCode } from "./types.js";

export interface PassedCheck {
  readonly id: string;
  readonly title: string;
}

export interface CheckSummary {
  readonly errors: number;
  readonly informational: number;
  readonly passed: number;
  readonly warnings: number;
}

/** A problem with the run itself, as the report carries it. */
export interface ReportDiagnostic {
  /**
   * Verbatim text from the plugin that failed.
   *
   * Present only when the user asked for it. Untrusted, and potentially secret: plugin errors quote
   * the input that broke them, and the files Aura reads are the ones holding API tokens.
   */
  readonly detail?: string | undefined;
  /** What produced the problem: an adapter id, or a check id. */
  readonly id: string;
  /** One sentence naming the problem, in terms the user can act on. */
  readonly message: string;
  /** The path involved, when the problem is about one. */
  readonly path?: string | undefined;
  /** Where it happened: a phase of the scan, or the check pass that followed it. */
  readonly phase: ScanPhase | "check";
}

/**
 * The state of a run, as one word.
 *
 * `empty` is deliberately not `clean`: a run that had nothing to check has not established that
 * anything is fine, and reporting it as clean is the one failure mode a setup doctor cannot have.
 */
export type ReportStatus = "clean" | "empty" | "error" | "warning";

export interface CheckReport {
  readonly diagnostics: readonly ReportDiagnostic[];
  readonly exitCode: CliExitCode;
  readonly findings: readonly Finding[];
  readonly passedChecks: readonly PassedCheck[];
  /** Applications that were looked for and not found. Not a problem, but worth being able to see. */
  readonly skipped: readonly SkippedApp[];
  readonly status: ReportStatus;
  readonly summary: CheckSummary;
}

/** Everything one report is assembled from. */
export interface CheckReportInput {
  /** Every registered check, including the ones that reported nothing. */
  readonly checks: readonly Check[];
  /** Checks that could not run. */
  readonly checkDiagnostics: readonly CheckDiagnostic[];
  readonly findings: readonly Finding[];
  /** Problems from the scan that produced the model. */
  readonly scanDiagnostics: readonly ScanDiagnostic[];
  readonly skipped: readonly SkippedApp[];
  /** Whether to carry each diagnostic's untrusted plugin text into the report. */
  readonly withDetail: boolean;
}

export function createCheckReport(input: CheckReportInput): CheckReport {
  const checkIdsWithFindings = new Set(input.findings.map((finding) => finding.checkId));
  const checkIdsWithDiagnostics = new Set(
    input.checkDiagnostics.map((diagnostic) => diagnostic.checkId),
  );
  const passedChecks = input.checks
    .filter(
      (check) => !checkIdsWithFindings.has(check.id) && !checkIdsWithDiagnostics.has(check.id),
    )
    .map((check) => Object.freeze({ id: check.id, title: check.title }));
  const summary: CheckSummary = Object.freeze({
    errors: countSeverity(input.findings, "error"),
    informational: countSeverity(input.findings, "info"),
    passed: passedChecks.length,
    warnings: countSeverity(input.findings, "warn"),
  });
  const diagnostics = [
    ...input.scanDiagnostics.map((diagnostic) =>
      toReportDiagnostic(
        {
          detail: diagnostic.detail,
          id: diagnostic.adapterId,
          message: diagnostic.message,
          path: diagnostic.path,
          phase: diagnostic.phase,
        },
        input.withDetail,
      ),
    ),
    ...input.checkDiagnostics.map((diagnostic) =>
      toReportDiagnostic(
        {
          detail: diagnostic.detail,
          id: diagnostic.checkId,
          message: diagnostic.message,
          phase: "check",
        },
        input.withDetail,
      ),
    ),
  ];
  const status = resolveStatus(summary, diagnostics, input.checks);

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    exitCode: EXIT_CODES[status],
    findings: input.findings,
    passedChecks: Object.freeze(passedChecks),
    skipped: input.skipped,
    status,
    summary,
  });
}

/** What a diagnostic carries into the report, and what is left behind. */
interface DiagnosticSource {
  readonly detail?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly path?: string | undefined;
  readonly phase: ScanPhase | "check";
}

/**
 * Rebuilds a diagnostic rather than spreading it.
 *
 * `detail` is untrusted plugin text and is only present when the user asked for it, so the report
 * is assembled field by field: a spread would carry it into machine-readable output by default.
 */
function toReportDiagnostic(source: DiagnosticSource, withDetail: boolean): ReportDiagnostic {
  return Object.freeze({
    id: source.id,
    message: source.message,
    phase: source.phase,
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(withDetail && source.detail !== undefined ? { detail: source.detail } : {}),
  });
}

function countSeverity(findings: readonly Finding[], severity: Finding["severity"]): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

/**
 * The process status each state maps to.
 *
 * `empty` exits like an error on purpose. Nothing was inspected, so the run established nothing,
 * and a pipeline reading the exit code must not be told otherwise.
 */
const EXIT_CODES: Readonly<Record<ReportStatus, CliExitCode>> = {
  clean: 0,
  empty: 2,
  error: 2,
  warning: 1,
};

function resolveStatus(
  summary: CheckSummary,
  diagnostics: readonly ReportDiagnostic[],
  checks: readonly Check[],
): ReportStatus {
  if (summary.errors > 0 || diagnostics.length > 0) {
    return "error";
  }
  if (checks.length === 0) {
    return "empty";
  }
  if (summary.warnings > 0) {
    return "warning";
  }
  return "clean";
}
