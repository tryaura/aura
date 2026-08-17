import type { CliDistro, CliExitCode, CliRuntime } from "./types.js";

export declare function runCli(distro: CliDistro, runtime?: CliRuntime): Promise<CliExitCode>;
export type {
  CheckCounts,
  CheckExplanation,
  CheckExplanationV1,
  CheckReport,
  CheckReportV1,
  CheckSummary,
  PassedCheck,
  ReportApp,
  ReportDiagnostic,
  ReportFinding,
  ReportFix,
  ReportFixOperation,
  ReportStatus,
} from "./report-types.js";
export type {
  CliBranding,
  CliDistro,
  CliExitCode,
  CliRegistryOptions,
  CliRuntime,
} from "./types.js";
