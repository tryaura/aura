export { runCli, runStandaloneCli } from "./run.boundary.js";
export { arrayFlag, booleanFlag, stringFlag } from "./distro-command-flags.js";
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
  CliCommandDefinition,
  CliCommandEvent,
  CliCommandExample,
  CliCommandFlag,
  CliCommandFlagValue,
  CliCommandInvocation,
  CliCommandTelemetry,
  CliDistro,
  CliExitCode,
  CliRegistryOptions,
  CliRuntime,
} from "./types.js";
export type { CliUpdates } from "./update/types.js";
