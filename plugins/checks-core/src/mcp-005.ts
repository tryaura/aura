import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type McpServer,
  type Scope,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { desiredMcpTargets, type DesiredMcpTarget } from "./mcp-common.js";
import { appFor, isPlacedAt, MCP_005_ID, scopeTarget, sourceFile } from "./mcp-005-placement.js";

const EXPLAIN = `Aura-managed MCP servers are personal and belong in global application configuration. Repository MCP files remain visible to diagnostics, but Aura never edits or removes their entries.

Every finding here is yours to resolve, because the only remaining move is in a file Aura will not write. MCP-001 reports the global entry that is missing and can add it for you; this check reports the entry left behind, which you remove by hand once you no longer want it there.`;

export const mcp005 = defineCheck({
  defaultSeverity: "warn",
  detect: detectScopePlacement,
  explain: EXPLAIN,
  fixability: "manual",
  id: MCP_005_ID,
  scope: "global",
  title: "Managed MCP servers use global configuration",
});

function detectScopePlacement(model: WorkspaceModel): readonly DetectedFinding[] {
  const desired = desiredMcpTargets(model);
  return model.mcpServers.flatMap((server) => {
    const app = appFor(model, server.appId);
    // Desired targets are keyed by application and name, so at most one can match.
    const target = desired.find(
      (candidate) => candidate.appId === server.appId && candidate.name === server.name,
    );
    if (app === undefined || target === undefined || isPlacedAt(app, server, target)) {
      return [];
    }
    return [placementFinding(app, server, target)];
  });
}

function placementFinding(
  app: AppModel,
  server: McpServer,
  target: DesiredMcpTarget,
): DetectedFinding {
  const source = sourceFile(app, server.sourceId)?.spec;
  const destination = scopeTarget(app, target.scope)?.spec.path;
  const locations = [...new Set([source?.path, destination].filter((path) => path !== undefined))];
  return {
    details: placementDetails(app, source?.scope ?? server.scope, destination),
    fixability: "manual",
    id: `${server.appId}:${server.sourceId}:${server.name}:${server.scope}-to-global`,
    ...(locations.length === 0 ? {} : { locations: locations.map((path) => ({ path })) }),
    message: `Personal MCP server ${server.name} for ${app.displayName} is configured in ${source?.path ?? `${app.displayName}'s ${server.scope} MCP configuration`}.`,
    metadata: {
      actualScope: server.scope,
      appId: server.appId,
      serverName: server.name,
      sourceId: server.sourceId,
    },
  };
}

/**
 * What is wrong with where the entry is, in terms of the file it is actually in.
 *
 * The risk is a property of the file, not of the scope the application labels the entry with: a
 * server in `~/.claude.json` cannot be committed no matter which scope Claude Code applies it at,
 * and saying it could is the one thing that would send someone looking through their repository
 * for a leak that is not there.
 */
function placementDetails(
  app: AppModel,
  sourceScope: Scope,
  destination: string | undefined,
): string {
  const belongs =
    destination === undefined
      ? `It belongs in ${app.displayName}'s global MCP configuration.`
      : `It belongs in ${destination}.`;
  return sourceScope === "project"
    ? `This server is declared in repository configuration. Aura will not edit that file. ${belongs} MCP-001 reports the missing global entry and can add it with \`aura check --fix\`; remove the repository entry by hand once you no longer want it there.`
    : `This personal server is not in the global configuration target Aura manages. ${belongs} MCP-001 reports the missing global entry and can add it with \`aura check --fix\`; remove this entry by hand once you no longer want it there.`;
}
