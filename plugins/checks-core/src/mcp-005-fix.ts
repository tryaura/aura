import { mcpConvergenceBlockers, planManifestMcpConvergence } from "@tryaura/core";
import type {
  AppModel,
  Finding,
  FixPlan,
  McpServer,
  Scope,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { desiredMcpTargets, type DesiredMcpTarget } from "./mcp-common.js";
import { appFor, isScope, MCP_005_ID, scopeTarget, sourceFile } from "./mcp-005-placement.js";

const RERUN = "Run `aura check --only MCP-005` again.";

/**
 * Why Aura declined to move an entry itself.
 *
 * One value rather than a boolean, because the four reasons are four different things to tell
 * someone: a plan that reports "outside the ownership ledger" for a file Aura simply cannot parse
 * sends them to fix the wrong thing.
 */
type Obstruction = "blocked" | "no-destination" | "non-canonical-source" | "unowned";

interface PlacementIdentity {
  readonly actualScope: Scope;
  readonly appId: string;
  readonly expectedScope: Scope;
  readonly name: string;
  readonly sourceId: string;
}

interface ResolvedPlacement {
  readonly app: AppModel;
  readonly server: McpServer;
  readonly target: DesiredMcpTarget;
}

export function placementFix(finding: Finding, model: WorkspaceModel): FixPlan | undefined {
  const resolved = resolveFinding(finding, model);
  if (resolved === undefined) {
    return undefined;
  }
  const { app, server, target } = resolved;
  const blockers = mcpConvergenceBlockers(model, server.appId);
  const obstruction = moveObstruction(model, app, server, target, blockers.length > 0);
  return obstruction === undefined
    ? movePlan(model, app, server, target)
    : manualMove(
        model,
        resolved,
        obstruction,
        blockers.map((blocker) => blocker.message),
      );
}

/**
 * The application-wide convergence write, re-summarized as the move this finding asked for.
 *
 * Converging writes every managed server for the application, not only this one. The summary is
 * what the interactive chooser shows, so it names the move the user selected rather than repeating
 * the planner's own description for every finding on the same application.
 */
function movePlan(
  model: WorkspaceModel,
  app: AppModel,
  server: McpServer,
  target: DesiredMcpTarget,
): FixPlan | undefined {
  const plan = planManifestMcpConvergence(model, server.appId).plan;
  return plan === undefined
    ? undefined
    : {
        ...plan,
        summary: `Move MCP server ${server.name} into ${app.displayName}'s ${target.scope} MCP configuration.`,
      };
}

function moveObstruction(
  model: WorkspaceModel,
  app: AppModel,
  server: McpServer,
  target: DesiredMcpTarget,
  blocked: boolean,
): Obstruction | undefined {
  // Nowhere to move it outranks everything else: ownership and canonical sources do not matter
  // when the destination does not exist.
  if (scopeTarget(app, target.scope) === undefined) {
    return "no-destination";
  }
  if (
    model.manifest.status !== "ready" ||
    model.manifest.value.ownership[server.appId]?.mcpServerNames.includes(server.name) !== true
  ) {
    return "unowned";
  }
  if (scopeTarget(app, server.scope)?.spec.id !== server.sourceId) {
    return "non-canonical-source";
  }
  return blocked ? "blocked" : undefined;
}

function manualMove(
  model: WorkspaceModel,
  resolved: ResolvedPlacement,
  obstruction: Obstruction,
  blockers: readonly string[],
): FixPlan {
  const { app, server, target } = resolved;
  const source = sourceFile(app, server.sourceId)?.spec.path;
  if (obstruction === "no-destination" && target.scope === "project") {
    return unsupportedProjectScope(model, resolved, source, blockers);
  }

  return {
    manualSteps: [
      ...blockers,
      obstructionStep(app, server, obstruction),
      ...moveSteps(model, resolved, source, scopeTarget(app, target.scope)?.spec.path),
      RERUN,
    ],
    operations: [],
    summary: `Move MCP server ${server.name} into ${app.displayName}'s ${target.scope} MCP configuration manually.`,
  };
}

function obstructionStep(app: AppModel, server: McpServer, obstruction: Obstruction): string {
  switch (obstruction) {
    case "blocked": {
      return `Aura did not rewrite ${app.displayName}'s MCP configuration, because it cannot converge that configuration safely.`;
    }
    case "no-destination": {
      return `Aura cannot tell which file holds ${app.displayName}'s global MCP configuration, so it did not move server ${server.name} itself.`;
    }
    case "non-canonical-source": {
      const canonical = scopeTarget(app, server.scope)?.spec.path;
      const managed =
        canonical === undefined
          ? `the ${server.scope}-scope entries it manages for ${app.displayName}`
          : `the ${server.scope}-scope entries it manages for ${app.displayName} in ${canonical}`;
      return `Aura rewrites only ${managed}, and server ${server.name} is not one of them.`;
    }
    case "unowned": {
      return `MCP server ${server.name} is outside Aura's ownership ledger, so Aura did not change any configuration file.`;
    }
  }
}

/**
 * How to complete the move by hand.
 *
 * One step when both ends are the same file: an application can separate scopes inside a single
 * document — `~/.claude.json` holds Claude Code's global servers and its per-directory ones — and
 * "remove it from this file, then add it to this file" is not an instruction anyone can follow.
 */
function moveSteps(
  model: WorkspaceModel,
  resolved: ResolvedPlacement,
  source: string | undefined,
  destination: string | undefined,
): readonly string[] {
  const { app, server, target } = resolved;
  if (source !== undefined && source === destination) {
    return [
      `Move MCP server ${server.name} within ${source} into the entries ${app.displayName} applies at ${target.scope} scope, using its transport definition in ${model.manifest.path}.`,
    ];
  }
  return [
    `Remove MCP server ${server.name} from ${source ?? scopeLabel(app, server.scope)}.`,
    `Add MCP server ${server.name} to ${destination ?? scopeLabel(app, target.scope)} using its transport definition in ${model.manifest.path}.`,
  ];
}

function unsupportedProjectScope(
  model: WorkspaceModel,
  resolved: ResolvedPlacement,
  source: string | undefined,
  blockers: readonly string[],
): FixPlan {
  const { app, server } = resolved;
  return {
    manualSteps: [
      ...blockers,
      `${app.displayName} has no project-scope MCP configuration target, so Aura cannot move server ${server.name} out of ${source ?? scopeLabel(app, server.scope)}.`,
      `Either change server ${server.name} to global scope in ${model.manifest.path}, or remove ${server.appId} from that server's apps and configure a supported team distribution manually.`,
      RERUN,
    ],
    operations: [],
    summary: `Resolve MCP server ${server.name}'s unsupported project scope manually.`,
  };
}

function scopeLabel(app: AppModel, scope: Scope): string {
  return `${app.displayName}'s ${scope} MCP configuration`;
}

function resolveFinding(finding: Finding, model: WorkspaceModel): ResolvedPlacement | undefined {
  if (finding.checkId !== MCP_005_ID) {
    return undefined;
  }
  const identity = placementIdentity(finding);
  if (identity === undefined) {
    return undefined;
  }
  const app = appFor(model, identity.appId);
  const server = model.mcpServers.find((candidate) => matchesServer(candidate, identity));
  const target = desiredMcpTargets(model).find((candidate) => matchesTarget(candidate, identity));
  return app === undefined || server === undefined || target === undefined
    ? undefined
    : { app, server, target };
}

function placementIdentity(finding: Finding): PlacementIdentity | undefined {
  const appId = stringMetadata(finding, "appId");
  const name = stringMetadata(finding, "serverName");
  const sourceId = stringMetadata(finding, "sourceId");
  const actualScope = scopeMetadata(finding, "actualScope");
  const expectedScope = scopeMetadata(finding, "expectedScope");
  if (
    appId === undefined ||
    name === undefined ||
    sourceId === undefined ||
    actualScope === undefined ||
    expectedScope === undefined
  ) {
    return undefined;
  }
  return { actualScope, appId, expectedScope, name, sourceId };
}

function matchesServer(server: McpServer, identity: PlacementIdentity): boolean {
  return (
    server.appId === identity.appId &&
    server.name === identity.name &&
    server.sourceId === identity.sourceId &&
    server.scope === identity.actualScope
  );
}

function matchesTarget(target: DesiredMcpTarget, identity: PlacementIdentity): boolean {
  return (
    target.appId === identity.appId &&
    target.name === identity.name &&
    target.scope === identity.expectedScope
  );
}

function stringMetadata(finding: Finding, key: string): string | undefined {
  const value = finding.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function scopeMetadata(finding: Finding, key: string): Scope | undefined {
  const value = finding.metadata?.[key];
  return isScope(value) ? value : undefined;
}
