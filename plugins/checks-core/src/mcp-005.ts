import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type McpServer,
  type Scope,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { desiredMcpTargets, type DesiredMcpTarget } from "./mcp-common.js";
import { placementFix } from "./mcp-005-fix.js";
import { appFor, isPlacedAt, MCP_005_ID, scopeTarget, sourceFile } from "./mcp-005-placement.js";

const EXPLAIN = `The Aura manifest distinguishes personal MCP servers from team servers. Personal servers belong in global configuration; putting one in repository configuration can publish it to teammates through source control. Team servers belong in project configuration; keeping one only in personal configuration means teammates do not receive it and their setup drifts. Placement is judged by the file an entry is written in, not by the scope label alone, because an application can keep both kinds in one document.

Re-run with \`--fix\` to move an Aura-owned entry through the same manifest convergence and undo machinery as other MCP fixes. Aura never removes a name outside its ownership ledger automatically.`;

export const mcp005 = defineCheck({
  defaultSeverity: "warn",
  detect: detectScopePlacement,
  explain: EXPLAIN,
  fix: placementFix,
  fixability: "guided",
  id: MCP_005_ID,
  scope: "global",
  title: "Managed MCP servers use their manifest scope",
});

function detectScopePlacement(model: WorkspaceModel): readonly DetectedFinding[] {
  const desired = desiredMcpTargets(model);
  return model.mcpServers.flatMap((server) => {
    const app = appFor(model, server.appId);
    const targets = desired.filter(
      (target) => target.appId === server.appId && target.name === server.name,
    );
    if (
      app === undefined ||
      targets.length === 0 ||
      targets.some((target) => isPlacedAt(app, server, target))
    ) {
      return [];
    }
    // Prefer the target sharing this entry's scope: when the manifest selects the name for both
    // scopes and the entry is canonical for neither, the move to make is the one within its scope.
    const target = targets.find((candidate) => candidate.scope === server.scope) ?? targets[0];
    return target === undefined ? [] : [placementFinding(app, server, target)];
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
    details: placementDetails(app, source?.scope ?? server.scope, target.scope, destination),
    id: `${server.appId}:${server.sourceId}:${server.name}:${server.scope}-to-${target.scope}`,
    ...(locations.length === 0 ? {} : { locations: locations.map((path) => ({ path })) }),
    message: `${target.scope === "global" ? "Personal" : "Team"} MCP server ${server.name} for ${app.displayName} is configured in ${source?.path ?? `${app.displayName}'s ${server.scope} MCP configuration`}.`,
    metadata: {
      actualScope: server.scope,
      appId: server.appId,
      expectedScope: target.scope,
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
  targetScope: Scope,
  destination: string | undefined,
): string {
  const belongs =
    destination === undefined
      ? `It belongs in ${app.displayName}'s ${targetScope} MCP configuration.`
      : `It belongs in ${destination}.`;
  if (targetScope === "global") {
    return sourceScope === "project"
      ? `The manifest marks this as a personal server, and that file is inside the repository, where it can be committed and shared with teammates. ${belongs}`
      : `The manifest marks this as a personal server, but that entry applies only where it is configured rather than wherever ${app.displayName} runs. ${belongs}`;
  }
  return sourceScope === "project"
    ? `The manifest marks this as a team server, but that is not the repository file ${app.displayName} reads for shared servers, so teammates do not receive it. ${belongs}`
    : `The manifest marks this as a team server, and that file is personal to you, so teammates do not receive it and their setup can drift. ${belongs}`;
}
