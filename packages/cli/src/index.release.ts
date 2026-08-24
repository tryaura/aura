import type { TelemetrySink } from "@tryaura/aura-sdk";

import type { HttpTelemetrySinkOptions } from "./http-telemetry-sink.js";
import type { CliDistro, CliExitCode, CliRuntime } from "./types.js";
import type { CliUpdates } from "./update/types.js";

export declare function runCli(distro: CliDistro, runtime?: CliRuntime): Promise<CliExitCode>;
export declare function createHttpTelemetrySink(options: HttpTelemetrySinkOptions): TelemetrySink;
export declare function runStandaloneCli(
  distro: CliDistro,
  updates: CliUpdates,
  current: Pick<NodeJS.Process, "arch" | "execPath" | "platform">,
  runtime?: CliRuntime,
): Promise<CliExitCode>;
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
  CliCommandDefinition,
  CliCommandExample,
  CliCommandFlag,
  CliCommandFlagValue,
  CliCommandInvocation,
  CliDistro,
  CliExitCode,
  CliRegistryOptions,
  CliRuntime,
} from "./types.js";
export type { CliUpdates } from "./update/types.js";
