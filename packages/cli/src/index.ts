export { runCli } from "./run.boundary.js";
export { createHttpTelemetrySink } from "./http-telemetry-sink.js";
export type {
  HttpTelemetryDeliveryFailure,
  HttpTelemetrySinkOptions,
} from "./http-telemetry-sink.js";
export type { TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";
export type {
  CheckReport,
  CheckReportV1,
  CheckCounts,
  CheckExplanation,
  CheckExplanationV1,
  CheckSummary,
  PassedCheck,
  ReportApp,
  ReportConfiguration,
  ReportDiagnostic,
  ReportFinding,
  ReportFix,
  ReportFixOperation,
  ReportRepositoryPreset,
  ReportStatus,
} from "./report-types.js";
export type {
  CliBranding,
  CliDistro,
  CliExitCode,
  CliRegistryOptions,
  CliRuntime,
} from "./types.js";
export { standaloneInstallation } from "./update/installation.js";
export type { StandaloneProcess } from "./update/installation.js";
export type {
  CliStandaloneInstallation,
  CliUpdateCandidate,
  CliUpdateSource,
  CliUpdateTarget,
  CliUpdates,
} from "./update/types.js";
