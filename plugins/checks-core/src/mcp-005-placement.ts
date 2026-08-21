import { CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS } from "@tryaura/adapter-claude-code";
import { CODEX_ADAPTER_ID, CODEX_SOURCE_IDS } from "@tryaura/adapter-codex";
import { CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS } from "@tryaura/adapter-cursor";
import type { AppModel, McpServer, Scope, WorkspaceModel } from "@tryaura/aura-sdk";

import type { DesiredMcpTarget } from "./mcp-common.js";

/** Identifier every MCP-005 module stamps and matches on. */
export const MCP_005_ID = "MCP-005";

interface McpScopeTargets {
  readonly global?: string | undefined;
  readonly project?: string | undefined;
}

/** One application's configuration file, as a scan reports it. */
export type McpSourceFile = AppModel["sourceFiles"][number];

/** Canonical writable MCP target for each scope supported by an official adapter. */
const OFFICIAL_SCOPE_TARGETS: Readonly<Record<string, McpScopeTargets>> = Object.freeze({
  [CLAUDE_CODE_ADAPTER_ID]: {
    global: CLAUDE_CODE_SOURCE_IDS.mcp,
    project: CLAUDE_CODE_SOURCE_IDS.mcpProject,
  },
  [CODEX_ADAPTER_ID]: { global: CODEX_SOURCE_IDS.mcp },
  [CURSOR_ADAPTER_ID]: {
    global: CURSOR_SOURCE_IDS.mcpGlobal,
    project: CURSOR_SOURCE_IDS.mcpProject,
  },
});

export function appFor(model: WorkspaceModel, appId: string): AppModel | undefined {
  return model.apps.find((app) => app.adapterId === appId);
}

/** The one file an application keeps its `scope` MCP entries in, when exactly one is identifiable. */
export function scopeTarget(app: AppModel, scope: Scope): McpSourceFile | undefined {
  const official = OFFICIAL_SCOPE_TARGETS[app.adapterId];
  if (official !== undefined) {
    const sourceId = official[scope];
    return sourceId === undefined
      ? undefined
      : app.sourceFiles.find((file) => file.spec.id === sourceId);
  }
  const candidates = app.sourceFiles.filter(
    (file) => file.spec.kind === "mcp" && file.spec.scope === scope,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The file a configured entry was read from. */
export function sourceFile(app: AppModel, sourceId: string): McpSourceFile | undefined {
  return app.sourceFiles.find((file) => file.spec.id === sourceId);
}

/**
 * Whether a configured entry already sits where the manifest asks for it.
 *
 * Scope alone does not answer this. `claude mcp add` files a server under `projects` in
 * `~/.claude.json` by default, which the adapter models at project scope against the global file's
 * spec — so an entry can carry the scope the manifest wants while sitting in neither the file
 * teammates receive nor the one that applies wherever the application runs. What a move has to
 * change is the file, so the file is what placement is judged on.
 */
export function isPlacedAt(app: AppModel, server: McpServer, target: DesiredMcpTarget): boolean {
  if (server.scope !== target.scope) {
    return false;
  }
  const canonical = scopeTarget(app, target.scope);
  // An adapter whose scope target Aura cannot identify keeps the benefit of the doubt: a move with
  // no nameable destination is a warning with no remedy.
  return canonical === undefined || canonical.spec.id === server.sourceId;
}
