import { isDeepStrictEqual } from "node:util";

import { mcpConvergenceBlockers, planManifestMcpConvergence } from "@tryaura/core";
import {
  normalizeMcpServerDefinition,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type McpConvergenceBlocker,
  type McpServerDefinition,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

export interface DesiredMcpTarget {
  readonly appId: string;
  readonly name: string;
  readonly scope: WorkspaceModel["mcpServers"][number]["scope"];
  readonly transport: McpServerDefinition;
}

/**
 * The servers the manifest selects for applications this scan can actually converge.
 *
 * Two exclusions, for the same reason: an application with `managed: false` is one the user told
 * Aura to leave alone, and an application the scan did not detect is one Aura cannot write to at
 * all. Reporting either produces a finding whose only remedy is editing the manifest by hand.
 */
export function desiredMcpTargets(model: WorkspaceModel): readonly DesiredMcpTarget[] {
  const manifest = model.manifest;
  if (manifest.status !== "ready") {
    return [];
  }
  const detected = new Set(model.apps.map((app) => app.adapterId));
  return manifest.value.mcpServers.flatMap((server) =>
    server.apps.flatMap((appId) =>
      detected.has(appId) && manifest.value.apps[appId]?.managed === true
        ? [{ appId, name: server.name, scope: server.scope, transport: server.transport }]
        : [],
    ),
  );
}

/** Whether a configured server is what the manifest asks for, scope included. */
export function transportMatches(
  target: DesiredMcpTarget,
  actual: WorkspaceModel["mcpServers"][number],
): boolean {
  try {
    return isDeepStrictEqual(actual.transport, normalizeMcpServerDefinition(target.transport));
  } catch {
    // A manifest Aura refuses to write is reported as a convergence blocker, not as drift.
    return true;
  }
}

/** Configured entries matching a desired target that the application will not actually run. */
export function unusableFor(
  model: WorkspaceModel,
  target: DesiredMcpTarget,
): WorkspaceModel["unusableMcpServers"][number] | undefined {
  return model.unusableMcpServers.find(
    (entry) =>
      entry.appId === target.appId && entry.name === target.name && entry.scope === target.scope,
  );
}

/** Configured servers matching a desired target, compared on the identity a write uses. */
export function configuredFor(
  model: WorkspaceModel,
  target: DesiredMcpTarget,
): WorkspaceModel["mcpServers"] {
  return model.mcpServers.filter(
    (server) =>
      server.appId === target.appId && server.name === target.name && server.scope === target.scope,
  );
}

/**
 * Whether MCP-005, rather than MCP-001, owns this target's absent expected-scope entry.
 *
 * Takes the desired list rather than deriving it: the caller evaluates this once per target, and
 * recomputing the manifest's selection inside that loop rebuilt the whole list every time.
 */
export function hasMisplacedServerFor(
  model: WorkspaceModel,
  desired: readonly DesiredMcpTarget[],
  target: DesiredMcpTarget,
): boolean {
  return model.mcpServers.some(
    (server) =>
      server.appId === target.appId &&
      server.name === target.name &&
      server.scope !== target.scope &&
      !desired.some(
        (candidate) =>
          candidate.appId === server.appId &&
          candidate.name === server.name &&
          candidate.scope === server.scope,
      ),
  );
}

/** Turns one application's convergence blockers into findings a user can act on. */
function blockerFindings(
  appId: string,
  blockers: readonly McpConvergenceBlocker[],
): readonly DetectedFinding[] {
  return blockers.map((blocker, index) => ({
    details: blocker.message,
    fixability: "manual",
    id: `blocker:${appId}:${blocker.sourceId ?? blocker.scope ?? String(index)}`,
    ...(blocker.path === undefined ? {} : { locations: [{ path: blocker.path }] }),
    message: `Aura cannot safely converge MCP configuration for ${appId}.`,
    metadata: {
      appId,
      kind: "blocker",
      ...(blocker.sourceId === undefined ? {} : { sourceId: blocker.sourceId }),
    },
  }));
}

/**
 * Downgrades findings whose application cannot converge, optionally reporting why.
 *
 * Only one check reports the blockers themselves. Both would describe the same obstruction in the
 * same words, and a user reading two copies has to work out that it is one problem.
 */
export function withBlockers(
  findings: readonly DetectedFinding[],
  affected: ReadonlySet<string>,
  model: WorkspaceModel,
  options: { readonly report: boolean },
): readonly DetectedFinding[] {
  const blockers = new Map<string, readonly McpConvergenceBlocker[]>();
  for (const appId of affected) {
    blockers.set(appId, mcpConvergenceBlockers(model, appId));
  }
  return [
    ...findings.map((finding) => withManualBlocker(finding, blockers)),
    ...(options.report
      ? [...blockers].flatMap(([appId, appBlockers]) => blockerFindings(appId, appBlockers))
      : []),
  ];
}

function withManualBlocker(
  finding: DetectedFinding,
  blockers: ReadonlyMap<string, readonly McpConvergenceBlocker[]>,
): DetectedFinding {
  const appId = finding.metadata?.["appId"];
  const blocked = typeof appId === "string" && (blockers.get(appId)?.length ?? 0) > 0;
  return blocked ? { ...finding, fixability: "manual" } : finding;
}

export function convergenceFix(finding: Finding, model: WorkspaceModel): FixPlan | undefined {
  const appId = finding.metadata?.["appId"];
  if (typeof appId !== "string") {
    return undefined;
  }
  const convergence = planManifestMcpConvergence(model, appId);
  return convergence.blockers.length === 0 ? convergence.plan : undefined;
}
