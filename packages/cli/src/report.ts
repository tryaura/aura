import type {
  Adapter,
  AppModel,
  AuraEffectiveConfig,
  Check,
  Finding,
  Severity,
} from "@tryaura/aura-sdk";
import { effectiveCheckConfiguration } from "@tryaura/core";
import type { CheckDiagnostic, ScanDiagnostic, SkippedApp } from "@tryaura/core";

import { checkCategory } from "./check-selection.js";
import { reportApps, reportFinding } from "./report-shapes.js";
import type {
  CheckCounts,
  CheckExplanation,
  CheckReport,
  PassedCheck,
  ReportDiagnostic,
  ReportFix,
  ReportStatus,
} from "./report-types.js";
import type { CliExitCode } from "./types.js";

// The per-item shapes and the functions that build them live together in report-shapes; this module
// owns the envelope around them. Re-exported here because the envelope is the published entry point.
export type { CheckExplanation, CheckReport, ReportFix } from "./report-types.js";

const CHECK_JSON_SCHEMA_VERSION = 1;

export function createCheckExplanation(
  check: Check,
  config: AuraEffectiveConfig,
): CheckExplanation {
  const effective = effectiveCheckConfiguration(check, config);
  return Object.freeze({
    enabled: effective.enabled.value,
    explain: check.explain,
    fixability: check.fixability,
    fixesApplicable: effective.enabled.value && check.fixability !== "manual",
    id: check.id,
    kind: "check-explanation",
    provenance: Object.freeze({
      enabled: effective.enabled.provenance,
      severity: effective.severity.provenance,
      thresholds: effective.thresholds.provenance,
    }),
    ...(config.preset === undefined ? {} : { preset: config.preset }),
    schemaVersion: CHECK_JSON_SCHEMA_VERSION,
    scope: check.scope,
    severity: effective.severity.value,
    thresholds: effective.thresholds.value,
    title: check.title,
  });
}

/**
 * The document a `--json` run emits when the run itself failed unexpectedly.
 *
 * `--json` promises exactly one parseable document on stdout (docs/cli-ux.md), and an operational
 * failure still owes the caller that document — an empty stdout on exit 3 breaks every consumer
 * that parses unconditionally. Nothing was established about the machine, so every list is empty,
 * one diagnostic names the failure, and the status carries exit 3. The human explanation goes to
 * stderr as on any other failure; `detail` stays withheld here for the same reason
 * {@link toReportDiagnostic} withholds it without `--detail`.
 */
export function createOperationalFailureReport(message: string, detail?: string): CheckReport {
  return createCheckReport({
    adapters: [],
    apps: [],
    checkDiagnostics: [{ checkId: "cli", detail, message }],
    checks: [],
    findings: [],
    scanDiagnostics: [],
    skipped: [],
    withDetail: detail !== undefined,
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
  /** The scan's record of adapters that looked for their application and did not find it. */
  readonly skipped: readonly SkippedApp[];
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
    apps: Object.freeze(reportApps(input.adapters, input.apps, input.skipped)),
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
  readonly phase: ReportDiagnostic["phase"];
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
