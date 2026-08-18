import { defineCheck, type DetectedFinding, type WorkspaceModel } from "@tryaura/aura-sdk";

import {
  configuredFor,
  convergenceFix,
  desiredMcpTargets,
  hasMisplacedServerFor,
  unusableFor,
  withBlockers,
  type DesiredMcpTarget,
} from "./mcp-common.js";

const EXPLAIN = `The Aura manifest is the desired MCP server list for every managed application. A missing server or an Aura-owned name that is no longer selected means the application has diverged from that desired state.

Aura adds selected servers and removes only names recorded in its ownership ledger. Unrelated user configuration remains untouched, and unsafe collisions require manual resolution.`;

export const mcp001 = defineCheck({
  defaultSeverity: "warn",
  detect: detectParity,
  explain: EXPLAIN,
  fix: convergenceFix,
  fixability: "auto",
  id: "MCP-001",
  scope: "global",
  title: "Managed applications have the manifest's MCP servers",
});

function detectParity(model: WorkspaceModel): readonly DetectedFinding[] {
  if (model.manifest.status !== "ready") {
    return [];
  }
  const desired = desiredMcpTargets(model);
  const desiredByApp = new Map<string, Set<string>>();
  const findings: DetectedFinding[] = [];
  const affected = new Set<string>();

  for (const target of desired) {
    const names = desiredByApp.get(target.appId) ?? new Set<string>();
    names.add(target.name);
    desiredByApp.set(target.appId, names);
    const finding = parityFinding(model, desired, target);
    if (finding !== undefined) {
      affected.add(target.appId);
      findings.push(finding);
    }
  }

  const stale = staleFindings(model, desiredByApp, affected);
  // Blockers are reported for every managed application, not only the ones with parity findings:
  // an application whose configuration Aura cannot converge is worth saying so about even when
  // nothing is missing yet, and MCP-002 stays silent about them so they are said once.
  return withBlockers([...findings, ...stale], managedApps(model), model, { report: true });
}

function managedApps(model: WorkspaceModel): ReadonlySet<string> {
  if (model.manifest.status !== "ready") {
    return new Set();
  }
  const manifest = model.manifest.value;
  return new Set(
    model.apps
      .map((app) => app.adapterId)
      .filter((appId) => manifest.apps[appId]?.managed === true),
  );
}

/**
 * Reports one desired server that the application is not running.
 *
 * "Missing" and "declared but not running" are different problems with different remedies, and
 * conflating them produces the contradiction of Aura offering to add a name that is already in the
 * file — where the write then refuses because it does not own it.
 */
function parityFinding(
  model: WorkspaceModel,
  desired: readonly DesiredMcpTarget[],
  target: DesiredMcpTarget,
): DetectedFinding | undefined {
  const unusable = unusableFor(model, target);
  if (unusable !== undefined) {
    return {
      details:
        unusable.reason === "disabled"
          ? "The entry is present but turned off, so the application does not start it. Aura will not enable a server someone switched off."
          : "The entry is present in a form Aura does not recognize, so it cannot tell whether the application runs it.",
      fixability: "manual",
      id: `unusable:${target.appId}:${target.name}`,
      message: `MCP server ${target.name} is configured in ${target.appId} but is not running.`,
      metadata: {
        appId: target.appId,
        kind: unusable.reason,
        serverName: target.name,
        sourceId: unusable.sourceId,
      },
    };
  }

  if (hasMisplacedServerFor(model, desired, target)) {
    return undefined;
  }

  return configuredFor(model, target).length > 0
    ? undefined
    : {
        id: `missing:${target.appId}:${target.name}`,
        message: `MCP server ${target.name} is missing from ${target.appId}.`,
        metadata: { appId: target.appId, kind: "missing", serverName: target.name },
      };
}

/**
 * Names Aura still owns that desired state no longer selects.
 *
 * Ownership for an application this scan did not detect is skipped: Aura cannot converge what is
 * not installed, and reporting it produces a warning whose only remedy is hand-editing the
 * manifest.
 */
function staleFindings(
  model: WorkspaceModel,
  desiredByApp: ReadonlyMap<string, ReadonlySet<string>>,
  affected: Set<string>,
): readonly DetectedFinding[] {
  if (model.manifest.status !== "ready") {
    return [];
  }
  const manifest = model.manifest.value;
  const findings: DetectedFinding[] = [];
  for (const [appId, ownership] of Object.entries(manifest.ownership)) {
    const detected = model.apps.some((app) => app.adapterId === appId);
    if (!detected || manifest.apps[appId]?.managed !== true) {
      continue;
    }
    const desiredNames = desiredByApp.get(appId) ?? new Set<string>();
    for (const name of ownership.mcpServerNames.filter((owned) => !desiredNames.has(owned))) {
      affected.add(appId);
      findings.push({
        id: `stale:${appId}:${name}`,
        message: `Aura still owns MCP server ${name} in ${appId}, but the manifest no longer selects it.`,
        metadata: { appId, kind: "stale", serverName: name },
      });
    }
  }
  return findings;
}
