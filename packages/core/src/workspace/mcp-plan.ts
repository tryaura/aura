import { isDeepStrictEqual } from "node:util";

import type {
  AppModel,
  AuraManifest,
  FileOperation,
  McpConvergenceBlocker,
  McpServer,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { createAuraManifestWriteOperation } from "../manifest/write.js";
import type { AppMcpConvergence, AppMcpConvergenceResult } from "./mcp-convergence.js";
import { desiredEntries, withOwnership, withoutServer } from "./mcp-plan-manifest.js";
import type {
  DesiredMcpConvergence,
  ManifestMcpConvergence,
  McpServerRemovalPlan,
} from "./mcp-plan-types.js";

export type {
  DesiredMcpConvergence,
  ManifestMcpConvergence,
  McpServerRemovalPlan,
} from "./mcp-plan-types.js";

/**
 * Planners for the applications in one scan, held outside the model they belong to.
 *
 * A planner closes over the configuration bytes core read. {@link AppModel} promises those are not
 * retained beside the documents parsed out of them, and a check holds an `AppModel`, so the
 * association lives here instead of on the object: reaching a planner takes this module, which
 * plugin code cannot import.
 */
const PLANNERS = new WeakMap<AppModel, AppMcpConvergence>();

/** Per-scan memo of what convergence planning produced, keyed by the model it was computed from. */
const PLANS = new WeakMap<WorkspaceModel, Map<string, ManifestMcpConvergence>>();

/** Associates a planner with the app model core just built for it. */
export function rememberMcpConvergence(app: AppModel, convergence: AppMcpConvergence): void {
  PLANNERS.set(app, convergence);
}

/**
 * Reports only why convergence is impossible, without rendering any file.
 *
 * What a check needs at detect time. The result is shared with {@link planManifestMcpConvergence},
 * so asking two checks and then a fix costs one evaluation rather than three — which matters
 * because evaluating it serializes every declared MCP target in full.
 */
export function mcpConvergenceBlockers(
  model: WorkspaceModel,
  appId: string,
): readonly McpConvergenceBlocker[] {
  return planManifestMcpConvergence(model, appId).blockers;
}

/** Builds application writes and the ownership-ledger update as one atomic fix plan. */
export function planManifestMcpConvergence(
  model: WorkspaceModel,
  appId: string,
): ManifestMcpConvergence {
  const memo = PLANS.get(model) ?? new Map<string, ManifestMcpConvergence>();
  PLANS.set(model, memo);
  const cached = memo.get(appId);
  if (cached !== undefined) {
    return cached;
  }
  const computed = computeConvergence(model, appId);
  memo.set(appId, computed);
  return computed;
}

/**
 * Plans one application's MCP configuration without writing the Aura manifest.
 *
 * Setup uses this primitive to converge several targets and then fold all returned ownership into
 * exactly one manifest write.
 */
export function planDesiredMcpConvergence(
  model: WorkspaceModel,
  desiredManifest: AuraManifest,
  appId: string,
): DesiredMcpConvergence {
  const manifestState = model.manifest;
  if (manifestState.status === "read-only") {
    return {
      blockers: [{ message: manifestState.problem.message, path: manifestState.path }],
      operations: [],
      ownedNames: desiredManifest.ownership[appId]?.mcpServerNames ?? [],
    };
  }

  const target = resolvePlanner(model, appId);
  if ("blockers" in target) {
    return {
      blockers: target.blockers,
      operations: [],
      ownedNames: desiredManifest.ownership[appId]?.mcpServerNames ?? [],
    };
  }
  if (desiredManifest.apps[appId]?.managed !== true) {
    return {
      blockers: [],
      operations: [],
      ownedNames: desiredManifest.ownership[appId]?.mcpServerNames ?? [],
    };
  }

  return target.convergence(
    desiredEntries(model, desiredManifest, appId),
    desiredManifest.ownership[appId]?.mcpServerNames ?? [],
  );
}

/**
 * Removes one Aura-owned server from one application while preserving its selection elsewhere.
 *
 * The configuration write and updated manifest/ownership ledger share one fix plan. Names outside
 * the ledger, unmanaged applications, and identities a name-only ledger cannot distinguish are
 * returned as blockers for a guided check to turn into manual steps.
 */
export function planMcpServerRemoval(
  model: WorkspaceModel,
  server: McpServer,
): McpServerRemovalPlan {
  const state = model.manifest;
  if (state.status !== "ready") {
    return {
      blockers: [
        {
          message:
            state.status === "read-only"
              ? state.problem.message
              : "The Aura manifest does not exist, so this server is outside Aura's ownership ledger.",
          path: state.path,
        },
      ],
      owned: false,
    };
  }
  const manifest = state.value;
  const owned = manifest.ownership[server.appId]?.mcpServerNames.includes(server.name) === true;
  if (!owned) {
    return {
      blockers: [
        {
          message: `MCP server ${server.name} is outside Aura's ownership ledger.`,
          scope: server.scope,
          sourceId: server.sourceId,
        },
      ],
      owned: false,
    };
  }
  if (manifest.apps[server.appId]?.managed !== true) {
    return {
      blockers: [
        {
          message: `Application ${server.appId} is not managed by Aura, so Aura will not rewrite its MCP configuration.`,
          scope: server.scope,
          sourceId: server.sourceId,
        },
      ],
      owned: true,
    };
  }
  if (ambiguousRemoval(model, server)) {
    return {
      blockers: [
        {
          message: `MCP server name ${server.name} identifies more than one configured or desired entry for ${server.appId}, and Aura's ledger cannot remove only one safely.`,
          scope: server.scope,
          sourceId: server.sourceId,
        },
      ],
      owned: true,
    };
  }

  return { ...computeConvergence(model, server.appId, withoutServer(manifest, server)), owned };
}

// fallow-ignore-next-line complexity -- preserves the planner's explicit manifest and ownership terminal states.
function computeConvergence(
  model: WorkspaceModel,
  appId: string,
  desiredManifest?: AuraManifest,
): ManifestMcpConvergence {
  const manifestState = model.manifest;
  if (manifestState.status === "read-only") {
    return { blockers: [{ message: manifestState.problem.message, path: manifestState.path }] };
  }
  if (manifestState.status === "missing") {
    return { blockers: [] };
  }

  const manifest = desiredManifest ?? manifestState.value;
  if (manifest.apps[appId]?.managed !== true) {
    return { blockers: [] };
  }
  const planned = planDesiredMcpConvergence(model, manifest, appId);
  const displayName = model.apps.find((app) => app.adapterId === appId)?.displayName ?? appId;
  return planned.blockers.length > 0
    ? { blockers: planned.blockers }
    : {
        blockers: [],
        plan: {
          operations: ledgeredOperations(manifestState, manifest, appId, planned),
          summary: `Converge ${displayName}'s MCP configuration from the Aura manifest.`,
        },
      };
}

/** The application writes, plus the ledger update when what Aura owns actually changed. */
function ledgeredOperations(
  state: ReadyManifest,
  manifest: AuraManifest,
  appId: string,
  planned: AppMcpConvergenceResult,
): readonly FileOperation[] {
  const next = withOwnership(manifest, appId, planned.ownedNames);
  return [
    ...planned.operations,
    ...(isDeepStrictEqual(next, state.value)
      ? []
      : [createAuraManifestWriteOperation(state, next)]),
  ];
}

function ambiguousRemoval(model: WorkspaceModel, server: McpServer): boolean {
  const configured = model.mcpServers.filter(
    (candidate) => candidate.appId === server.appId && candidate.name === server.name,
  );
  if (
    configured.length > 1 ||
    configured.some(
      (candidate) => candidate.scope !== server.scope || candidate.sourceId !== server.sourceId,
    )
  ) {
    return true;
  }
  if (model.manifest.status !== "ready") {
    return false;
  }
  return (
    model.manifest.value.mcpServers.filter(
      (entry) => entry.name === server.name && entry.apps.includes(server.appId),
    ).length > 1
  );
}

type ReadyManifest = Extract<WorkspaceModel["manifest"], { readonly status: "ready" }>;

function resolvePlanner(
  model: WorkspaceModel,
  appId: string,
): ManifestMcpConvergence | { readonly app: AppModel; readonly convergence: AppMcpConvergence } {
  const app = model.apps.find((candidate) => candidate.adapterId === appId);
  if (app === undefined) {
    return { blockers: [{ message: `Application ${appId} was not detected.` }] };
  }
  const convergence = PLANNERS.get(app);
  return convergence === undefined
    ? { blockers: [{ message: `${app.displayName}'s adapter cannot write MCP configuration.` }] }
    : { app, convergence };
}
