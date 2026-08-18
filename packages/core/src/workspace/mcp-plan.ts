import { isDeepStrictEqual } from "node:util";

import type {
  AppModel,
  AuraManifest,
  FileOperation,
  FixPlan,
  McpConvergenceBlocker,
  OwnedServerEntry,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { createAuraManifestWriteOperation } from "../manifest/write.js";
import type { AppMcpConvergence, AppMcpConvergenceResult } from "./mcp-convergence.js";

/** Result of building one application's complete manifest-driven MCP remediation. */
export interface ManifestMcpConvergence {
  readonly blockers: readonly McpConvergenceBlocker[];
  readonly plan?: FixPlan | undefined;
}

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

function computeConvergence(model: WorkspaceModel, appId: string): ManifestMcpConvergence {
  const manifestState = model.manifest;
  if (manifestState.status === "read-only") {
    return { blockers: [{ message: manifestState.problem.message, path: manifestState.path }] };
  }
  if (manifestState.status === "missing") {
    return { blockers: [] };
  }

  const target = resolvePlanner(model, appId);
  if ("blockers" in target) {
    return target;
  }
  // Unmanaged means Aura leaves the application alone, not that it undoes itself: the ownership
  // ledger is kept so that re-enabling management picks up where it left off.
  const manifest = manifestState.value;
  if (manifest.apps[appId]?.managed !== true) {
    return { blockers: [] };
  }

  const planned = target.convergence(
    desiredEntries(manifest, appId),
    manifest.ownership[appId]?.mcpServerNames ?? [],
  );
  return planned.blockers.length > 0
    ? { blockers: planned.blockers }
    : {
        blockers: [],
        plan: {
          operations: ledgeredOperations(manifestState, appId, planned),
          summary: `Converge ${target.app.displayName}'s MCP configuration from the Aura manifest.`,
        },
      };
}

/** The application writes, plus the ledger update when what Aura owns actually changed. */
function ledgeredOperations(
  state: ReadyManifest,
  appId: string,
  planned: AppMcpConvergenceResult,
): readonly FileOperation[] {
  const next = withOwnership(state.value, appId, planned.ownedNames);
  return [
    ...planned.operations,
    ...(isDeepStrictEqual(next, state.value)
      ? []
      : [createAuraManifestWriteOperation(state, next)]),
  ];
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

function desiredEntries(manifest: AuraManifest, appId: string): readonly OwnedServerEntry[] {
  return manifest.mcpServers
    .filter((server) => server.apps.includes(appId))
    .map((server) => ({ name: server.name, scope: server.scope, transport: server.transport }));
}

function withOwnership(
  manifest: AuraManifest,
  appId: string,
  mcpServerNames: readonly string[],
): AuraManifest {
  const previous = manifest.ownership[appId];
  const ownership = {
    ...manifest.ownership,
    [appId]: { ...previous, files: previous?.files ?? [], mcpServerNames },
  };
  return { ...manifest, ownership };
}
