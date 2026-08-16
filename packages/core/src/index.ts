export { createEnvironment } from "./environment.js";
export type { EnvironmentBootOptions } from "./environment.js";
export { runChecks } from "./checks.js";
export type { CheckDiagnostic } from "./checks.js";
export {
  applyFixPlan,
  executeFixPlan,
  prepareFixPlan,
  previewFixPlan,
} from "./fix-plan/execute.js";
export { listFixPlanBackups, undoFixPlan } from "./fix-plan/undo.js";
export { prepareAutomaticFixes } from "./fix-plan/automatic.js";
export type { PreparedFixPlan } from "./fix-plan/execute.js";
export { FixPlanApplyError, FixPlanError, FixPlanUndoError } from "./fix-plan/types.js";
export type {
  FixPlanApplyOptions,
  FixPlanBackup,
  FixPlanBackupListOptions,
  FixPlanBackupStatus,
  FixOperationEffect,
  FixOperationPreview,
  FixPlanErrorCode,
  FixPlanExecutionOptions,
  FixPlanExecutionResult,
  FixPlanPreview,
  FixPlanPreviewOptions,
  FixPlanRollbackStatus,
  FixPlanUndoOptions,
  FixPlanUndoResult,
} from "./fix-plan/types.js";
export {
  AURA_MANAGED_BLOCK_BEGIN,
  AURA_MANAGED_BLOCK_END,
  AURA_MANAGED_BLOCK_NOTICE,
  hashManagedSnippet,
} from "./managed-block/protocol.js";
export { readManagedBlock } from "./managed-block/read.js";
export { reconcileManagedBlock } from "./managed-block/reconcile.js";
export type {
  DesiredManagedSnippet,
  ManagedBlockReadResult,
  ManagedBlockWriteResult,
} from "./managed-block/types.js";
export { createPluginRegistry } from "./plugin-registry.js";
export type { PluginRegistry, PluginRegistryOptions } from "./plugin-registry.js";
export { SUPPORTED_PLUGIN_API_VERSION } from "./plugin-validation.js";
export type { ContributionKind, PluginCandidate } from "./plugin-validation.js";
export { buildWorkspaceModel } from "./workspace/build.js";
export type { SkippedApp, WorkspaceScan, WorkspaceScanOptions } from "./workspace/build.js";
export { describeFailure } from "./workspace/diagnostics.js";
export type { ScanDiagnostic, ScanPhase } from "./workspace/diagnostics.js";
export { createFileReader, MAX_FILE_BYTES } from "./workspace/reader.js";
export type { FileReader, PathContents } from "./workspace/reader.js";
