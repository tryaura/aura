import type {
  AdapterSupport,
  FindingLocation,
  FindingPresentation,
  Fixability,
  JsonObject,
  Scope,
  Severity,
} from "@tryaura/aura-sdk";

import type { CliExitCode } from "./types.js";

interface ReportAppDetection {
  readonly authenticated?: boolean | undefined;
  readonly installed: boolean;
  readonly version?: string | undefined;
}

export interface ReportApp {
  readonly appId: string;
  readonly detection: ReportAppDetection;
  readonly detectionScope?: string | undefined;
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

export interface ReportDiagnostic {
  readonly detail?: string | undefined;
  readonly id: string;
  readonly message: string;
  readonly path?: string | undefined;
  readonly phase: "check" | "detect" | "files" | "fix" | "parse" | "read" | "support";
}

export type ReportStatus = "clean" | "empty" | "error" | "operational-error" | "warning";

export interface ReportFixOperation {
  readonly conflict?: string | undefined;
  readonly diff?: string | undefined;
  readonly effect:
    | "archive"
    | "conflict"
    | "create"
    | "move"
    | "noop"
    | "remove"
    | "symlink"
    | "update";
  readonly paths: readonly string[];
}

export interface ReportFix {
  readonly checkId: string;
  readonly findingId: string;
  readonly manualSteps: readonly string[];
  readonly message?: string | undefined;
  readonly operations: readonly ReportFixOperation[];
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
  readonly schemaVersion: 1;
  readonly status: ReportStatus;
  readonly summary: CheckSummary;
}

export type CheckReport = CheckReportV1;

export interface CheckExplanationV1 {
  readonly explain: string;
  readonly fixability: Fixability;
  readonly fixesApplicable: boolean;
  readonly id: string;
  readonly kind: "check-explanation";
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly severity: Severity;
  readonly title: string;
}

export type CheckExplanation = CheckExplanationV1;
