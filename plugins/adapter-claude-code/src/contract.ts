import { isConfigRecord, type AppModel } from "@tryaura/aura-sdk";

/**
 * The names this adapter puts into the workspace model, published for checks to read.
 *
 * A check that reached for these as string literals would keep compiling after a rename here and
 * silently stop finding anything, so the contract is exported and imported rather than retyped.
 *
 * Every one of these names a file the adapter declares, which is what lets a check turn a model
 * entry back into a path through `AppModel.sourceFiles`. The local-scope MCP servers get no id of
 * their own for exactly that reason: they are stored inside `~/.claude.json` and are found, and
 * edited, there — `scope` is what tells them apart from the global servers beside them.
 */
export const CLAUDE_CODE_SOURCE_IDS = Object.freeze({
  instructions: "claude-code.instructions.global",
  instructionsProject: "claude-code.instructions.project",
  mcp: "claude-code.mcp.global",
  mcpProject: "claude-code.mcp.project",
  settingsGlobal: "claude-code.settings.global",
  settingsLocal: "claude-code.settings.local",
  settingsProject: "claude-code.settings.project",
});

export const CLAUDE_CODE_ADAPTER_ID = "claude-code";

/** Metadata key holding {@link ClaudePermissions}. */
export const CLAUDE_PERMISSIONS_KEY = "claudePermissions";

/** The permission mode Claude Code starts in, and the settings file that sets it. */
export interface ClaudePermissionMode {
  readonly mode: string;
  /** Key in {@link CLAUDE_CODE_SOURCE_IDS} naming the file, for locating it in `sourceFiles`. */
  readonly sourceId: string;
}

/**
 * Reads the permission mode this adapter recorded, resolved across scopes.
 *
 * Which scope wins is Claude Code's rule, not a check's, so it is applied here:
 * `.claude/settings.local.json` overrides the shared project settings, which override the global
 * default. A check that re-derived this would drift from the adapter that actually models the
 * application.
 */
export function readClaudePermissionMode(app: AppModel): ClaudePermissionMode | undefined {
  const permissions = app.metadata?.[CLAUDE_PERMISSIONS_KEY];
  if (!isConfigRecord(permissions)) {
    return undefined;
  }

  const local = readMode(permissions["local"]);
  if (local !== undefined) {
    return { mode: local, sourceId: CLAUDE_CODE_SOURCE_IDS.settingsLocal };
  }

  const project = readMode(permissions["project"]);
  if (project !== undefined) {
    return { mode: project, sourceId: CLAUDE_CODE_SOURCE_IDS.settingsProject };
  }

  const global = readMode(permissions["global"]);
  return global === undefined
    ? undefined
    : { mode: global, sourceId: CLAUDE_CODE_SOURCE_IDS.settingsGlobal };
}

function readMode(value: unknown): string | undefined {
  if (!isConfigRecord(value)) {
    return undefined;
  }
  const defaultMode = value["defaultMode"];
  return typeof defaultMode === "string" ? defaultMode : undefined;
}
