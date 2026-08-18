import type { TelemetrySink } from "@tryaura/aura-sdk";

import type { HttpTelemetrySinkOptions } from "./http-telemetry-sink.js";
import type { CliDistro, CliExitCode, CliRuntime } from "./types.js";

export declare function runCli(distro: CliDistro, runtime?: CliRuntime): Promise<CliExitCode>;
export declare function createHttpTelemetrySink(options: HttpTelemetrySinkOptions): TelemetrySink;
export type {
  HttpTelemetryDeliveryFailure,
  HttpTelemetrySinkOptions,
} from "./http-telemetry-sink.js";
export type { TelemetryEvent, TelemetrySink } from "@tryaura/aura-sdk";
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
