import type {
  Adapter,
  AdapterSupport,
  AppModel,
  Check,
  Finding,
  FindingLocation,
  FindingPresentation,
  Fixability,
  JsonObject,
  Scope,
  Severity,
} from "@tryaura/aura-sdk";
import type { CheckDiagnostic, FixOperationEffect, ScanDiagnostic, ScanPhase } from "@tryaura/core";

import { checkCategory } from "./check-selection.js";
import { reportApps, reportFinding } from "./report-shapes.js";
import type { CliExitCode } from "./types.js";

const CHECK_JSON_SCHEMA_VERSION = 1;

export interface PassedCheck {
  readonly id: string;
  readonly title: string;
}

export interface CheckCounts {
  readonly errors: number;
  readonly informational: number;
  readonly passed: number;
  readonly warnings: number;
}

export interface CheckSummary extends CheckCounts {
  readonly categories: Readonly<Record<string, CheckCounts>>;
  readonly diagnostics: number;
  readonly exitCode: CliExitCode;
}

/** A problem with the run itself, as the report carries it. */
export interface ReportDiagnostic {
  readonly detail?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly path?: string | undefined;
  readonly phase: ScanPhase | "check" | "fix";
}

export type ReportStatus = "clean" | "empty" | "error" | "operational-error" | "warning";

interface ReportAppDetection {
  readonly authenticated?: boolean | undefined;
  readonly installed: boolean;
  readonly version?: string | undefined;
}

export interface ReportApp {
  readonly appId: string;
  readonly detection: ReportAppDetection;
  readonly displayName: string;
  readonly support?: AdapterSupport | undefined;
}

export interface ReportFinding {
  readonly checkId: string;
  readonly details?: string | undefined;
  readonly findingId: string;
  readonly fixability: Fixability;
  readonly locations?: readonly FindingLocation[] | undefined;
  readonly message: string;
  readonly metadata?: JsonObject | undefined;
  readonly presentation?: FindingPresentation | undefined;
  readonly scope: Scope;
  readonly severity: Severity;
}

export interface ReportFixOperation {
  readonly conflict?: string | undefined;
  readonly diff?: string | undefined;
  readonly effect: FixOperationEffect;
  readonly paths: readonly string[];
}

export interface ReportFix {
  readonly checkId: string;
  readonly findingId: string;
  readonly manualSteps: readonly string[];
  readonly message?: string | undefined;
  readonly operations: readonly ReportFixOperation[];
  /**
   * What the plan did to the filesystem.
   *
   * `failed` promises the filesystem is as it was; `partial` is the case that promise cannot cover,
   * where applying failed and unwinding it failed too, so some operations are still on disk.
   */
  readonly status: "applied" | "failed" | "partial" | "planned";
  readonly summary: string;
}

export interface CheckReportV1 {
  readonly apps: readonly ReportApp[];
  readonly diagnostics: readonly ReportDiagnostic[];
  readonly findings: readonly ReportFinding[];
  readonly fixes?: readonly ReportFix[] | undefined;
  readonly kind: "check-report";
  readonly passedChecks: readonly PassedCheck[];
  readonly schemaVersion: typeof CHECK_JSON_SCHEMA_VERSION;
  readonly status: ReportStatus;
  readonly summary: CheckSummary;
}

/** Backwards-compatible name for the frozen version 1 report envelope. */
export type CheckReport = CheckReportV1;

export interface CheckExplanationV1 {
  readonly explain: string;
  readonly fixability: Fixability;
  readonly fixesApplicable: boolean;
  readonly id: string;
  readonly kind: "check-explanation";
  readonly schemaVersion: typeof CHECK_JSON_SCHEMA_VERSION;
  readonly scope: Scope;
  readonly severity: Severity;
  readonly title: string;
}

/** Backwards-compatible name for the frozen version 1 explanation envelope. */
export type CheckExplanation = CheckExplanationV1;

export function createCheckExplanation(check: Check): CheckExplanation {
  return Object.freeze({
    explain: check.explain,
    fixability: check.fixability,
    fixesApplicable: check.fixability !== "manual",
    id: check.id,
    kind: "check-explanation",
    schemaVersion: CHECK_JSON_SCHEMA_VERSION,
    scope: check.scope,
    severity: check.defaultSeverity,
    title: check.title,
  });
}

export interface CheckReportInput {
  readonly adapters: readonly Adapter[];
  readonly apps: readonly AppModel[];
  readonly checkDiagnostics: readonly CheckDiagnostic[];
  readonly checks: readonly Check[];
  readonly findings: readonly Finding[];
  readonly fixDiagnostics?: readonly DiagnosticSource[] | undefined;
  readonly fixes?: readonly ReportFix[] | undefined;
  readonly forcedExitCode?: CliExitCode | undefined;
  readonly scanDiagnostics: readonly ScanDiagnostic[];
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
  const diagnostics = diagnosticsFor(input);
  const status = resolveStatus(input.findings, diagnostics, input.checks, input.forcedExitCode);
  const exitCode = EXIT_CODES[status];
  const summary = Object.freeze({
    categories: categoryCounts(input.checks, input.findings, passedChecks),
    diagnostics: diagnostics.length,
    errors: countSeverity(input.findings, "error"),
    exitCode,
    informational: countSeverity(input.findings, "info"),
    passed: passedChecks.length,
    warnings: countSeverity(input.findings, "warn"),
  });

  return Object.freeze({
    apps: Object.freeze(reportApps(input.adapters, input.apps)),
    diagnostics: Object.freeze(diagnostics),
    findings: Object.freeze(input.findings.map((finding) => reportFinding(finding, input.checks))),
    ...(input.fixes === undefined ? {} : { fixes: Object.freeze([...input.fixes]) }),
    kind: "check-report",
    passedChecks: Object.freeze(passedChecks),
    schemaVersion: CHECK_JSON_SCHEMA_VERSION,
    status,
    summary,
  });
}

function diagnosticsFor(input: CheckReportInput): ReportDiagnostic[] {
  return [
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
    ...(input.fixDiagnostics ?? []).map((diagnostic) =>
      toReportDiagnostic({ ...diagnostic, phase: "fix" }, input.withDetail),
    ),
  ];
}

export interface DiagnosticSource {
  readonly detail?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly path?: string | undefined;
  readonly phase: ScanPhase | "check" | "fix";
}

function toReportDiagnostic(source: DiagnosticSource, withDetail: boolean): ReportDiagnostic {
  return Object.freeze({
    id: source.id,
    message: source.message,
    phase: source.phase,
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(withDetail && source.detail !== undefined ? { detail: source.detail } : {}),
  });
}

function categoryCounts(
  checks: readonly Check[],
  findings: readonly Finding[],
  passedChecks: readonly PassedCheck[],
): Readonly<Record<string, CheckCounts>> {
  const passed = new Set(passedChecks.map((check) => check.id));
  const categories = [...new Set(checks.map((check) => checkCategory(check.id)))].sort();
  const entries: [string, CheckCounts][] = categories.map((category) => {
    const categoryChecks = checks.filter((check) => checkCategory(check.id) === category);
    const ids = new Set(categoryChecks.map((check) => check.id));
    const categoryFindings = findings.filter((finding) => ids.has(finding.checkId));
    return [
      category,
      Object.freeze({
        errors: countSeverity(categoryFindings, "error"),
        informational: countSeverity(categoryFindings, "info"),
        passed: categoryChecks.filter((check) => passed.has(check.id)).length,
        warnings: countSeverity(categoryFindings, "warn"),
      }),
    ];
  });
  return Object.freeze(Object.fromEntries(entries));
}

function countSeverity(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length;
}

const EXIT_CODES: Readonly<Record<ReportStatus, CliExitCode>> = {
  clean: 0,
  empty: 2,
  error: 2,
  "operational-error": 3,
  warning: 1,
};

function resolveStatus(
  findings: readonly Finding[],
  diagnostics: readonly ReportDiagnostic[],
  checks: readonly Check[],
  forcedExitCode: CliExitCode | undefined,
): ReportStatus {
  if (forcedExitCode === 3 || diagnostics.length > 0) {
    return "operational-error";
  }
  if (forcedExitCode === 2) {
    return "error";
  }
  if (findings.some((finding) => finding.severity === "error")) {
    return "error";
  }
  if (checks.length === 0) {
    return "empty";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "warning";
  }
  return "clean";
}
