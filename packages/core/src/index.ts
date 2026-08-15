export { createEnvironment } from "./environment.js";
export type { EnvironmentBootOptions } from "./environment.js";
export {
  applyFixPlan,
  executeFixPlan,
  prepareFixPlan,
  previewFixPlan,
} from "./fix-plan/execute.js";
export type { PreparedFixPlan } from "./fix-plan/execute.js";
export { FixPlanApplyError, FixPlanError } from "./fix-plan/types.js";
export type {
  FixOperationEffect,
  FixOperationPreview,
  FixPlanErrorCode,
  FixPlanExecutionOptions,
  FixPlanExecutionResult,
  FixPlanPreview,
  FixPlanPreviewOptions,
  FixPlanRollbackStatus,
} from "./fix-plan/types.js";
export { createPluginRegistry } from "./plugin-registry.js";
export type { PluginRegistry, PluginRegistryOptions } from "./plugin-registry.js";
export { SUPPORTED_PLUGIN_API_VERSION } from "./plugin-validation.js";
export type { ContributionKind, PluginCandidate } from "./plugin-validation.js";
export { buildWorkspaceModel } from "./workspace/build.js";
export type { SkippedApp, WorkspaceScan, WorkspaceScanOptions } from "./workspace/build.js";
export type { ScanDiagnostic, ScanPhase } from "./workspace/diagnostics.js";
export { createFileReader, MAX_FILE_BYTES } from "./workspace/reader.js";
export type { FileReader, PathContents } from "./workspace/reader.js";
