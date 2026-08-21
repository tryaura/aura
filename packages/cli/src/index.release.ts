import type { TelemetrySink } from "@tryaura/aura-sdk";

import type { HttpTelemetrySinkOptions } from "./http-telemetry-sink.js";
import type { CliDistro, CliExitCode, CliRuntime } from "./types.js";
import type { StandaloneProcess } from "./update/installation.js";
import type { CliStandaloneInstallation } from "./update/types.js";

export declare function runCli(distro: CliDistro, runtime?: CliRuntime): Promise<CliExitCode>;
export declare function createHttpTelemetrySink(options: HttpTelemetrySinkOptions): TelemetrySink;
export declare function standaloneInstallation(
  current: StandaloneProcess,
): CliStandaloneInstallation | undefined;
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
export type { StandaloneProcess } from "./update/installation.js";
export type {
  CliStandaloneInstallation,
  CliUpdateCandidate,
  CliUpdateSource,
  CliUpdateTarget,
  CliUpdates,
} from "./update/types.js";
