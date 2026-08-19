export { createEnvironment } from "./environment.js";
export type { EnvironmentBootOptions } from "./environment.js";
export { createLimiter } from "./workspace/concurrency.js";
export { canonicalAppId } from "./app-id.js";
export { runChecks } from "./checks.js";
/** @public */
export type { CheckDiagnostic, CheckRun } from "./checks.js";
export {
  createEmptyAuraManifest,
  parseAuraManifest,
  serializeAuraManifest,
} from "./manifest/codec.js";
export {
  AURA_MANIFEST_FILE_MODE,
  AURA_MANIFEST_PATH,
  AURA_MANIFEST_SCHEMA_VERSION,
  resolveAuraManifestPath,
} from "./manifest/protocol.js";
export { AuraManifestError } from "./manifest/error.js";
export { readAuraManifest } from "./manifest/read.js";
export { assertAuraManifestWritable, createAuraManifestWriteOperation } from "./manifest/write.js";
export {
  applyFixPlan,
  executeFixPlan,
  prepareFixPlan,
  previewFixPlan,
} from "./fix-plan/execute.js";
export { listFixPlanBackups, undoFixPlan } from "./fix-plan/undo.js";
export {
  collectAutomaticFixCandidates,
  prepareAutomaticFixes,
  prepareFixCandidates,
} from "./fix-plan/automatic.js";
/** @public */
export type {
  AutomaticFixCandidates,
  AutomaticFixes,
  AutomaticFixOptions,
  FixCandidate,
  FixCandidatePreparationOptions,
  PreparedFixCandidates,
} from "./fix-plan/automatic.js";
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
export { diffManagedSnippet, reconcileManagedSnippet } from "./managed-block/reconcile-snippet.js";
export { reconcileManagedBlock, reconcileParsedManagedBlock } from "./managed-block/reconcile.js";
export {
  managedContentRevisionStatus,
  planSharedSkillTreeUpdate,
} from "./managed-content/revision.js";
/** @public */
export type { ManagedContentRevisionStatus } from "./managed-content/revision.js";
/** @public */
export type {
  DesiredManagedSnippet,
  ManagedBlock,
  ManagedBlockNote,
  ManagedBlockProblem,
  ManagedBlockProblemCode,
  ManagedBlockReadResult,
  ManagedBlockReconcileOptions,
  ManagedBlockWriteResult,
  ManagedSnippet,
  ManagedSnippetResolution,
} from "./managed-block/types.js";
export { createPluginRegistry } from "./plugin-registry.js";
/** @public */
export type {
  PluginRegistry,
  PluginRegistryOptions,
  RegisteredSkillPack,
} from "./plugin-registry.js";
export { SUPPORTED_PLUGIN_API_VERSION } from "./plugin-validation.js";
export type { ContributionKind, PluginCandidate } from "./plugin-validation.js";
export { buildWorkspaceModel } from "./workspace/build.js";
export type { SkippedApp, WorkspaceScan, WorkspaceScanOptions } from "./workspace/build.js";
export { createMcpUrlRequester } from "./workspace/mcp-url-request.js";
export { planSharedInstructionLink } from "./workspace/shared-link-plan.js";
export {
  isAuraOwnedSkillTarget,
  planSkillDeployment,
  sharedSkillsRoot,
  skillDeploymentStatus,
} from "./workspace/skill-deployment-plan.js";
/** @public */
export type {
  SharedInstructionLinkPlan,
  SharedInstructionLinkPlanOptions,
} from "./workspace/shared-link-plan.js";
export { projectSharedInstructionsPath } from "./workspace/shared-links.js";
export { describeFailure } from "./workspace/diagnostics.js";
export {
  mcpConvergenceBlockers,
  planDesiredMcpConvergence,
  planManifestMcpConvergence,
  planMcpServerRemoval,
} from "./workspace/mcp-plan.js";
/** @public */
export type {
  DesiredMcpConvergence,
  ManifestMcpConvergence,
  McpServerRemovalPlan,
} from "./workspace/mcp-plan.js";
export {
  canPlanMcpSecretRemediation,
  planMcpSecretRemediation,
} from "./workspace/mcp-secret-plan.js";
export type { ScanDiagnostic, ScanPhase } from "./workspace/diagnostics.js";
export { createFileReader, MAX_FILE_BYTES } from "./workspace/reader.js";
export { createHttpGet, vetHttpUrl } from "./http.js";
export { createHttpPost } from "./http-post.js";
export { listDirectorySkills, resolveDirectorySkills } from "./skills/directory-client.js";
export type { DirectorySkillListingResult } from "./skills/directory-client.js";
export { collectSkillDirectorySources, isSkillSourceAllowed } from "./skills/sources.js";
export { AURA_TEAM_PRESET_PATH } from "./preset/protocol.js";
export {
  effectiveCheckConfiguration,
  enabledChecks,
  resolveEffectiveConfig,
} from "./preset/configuration.js";
export { loadTeamPreset } from "./preset/load.js";
export { applyRequiredMcpServers } from "./preset/required-mcp.js";
export type { RequiredMcpProjection } from "./preset/required-mcp.js";
/** @public */
export type { FileReader, FileReadOptions, PathContents } from "./workspace/reader.js";
