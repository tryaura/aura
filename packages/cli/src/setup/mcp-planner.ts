import { join } from "node:path";

import {
  mcpEnvironmentVariableNames,
  type AuraManifest,
  type FileOperation,
} from "@tryaura/aura-sdk";
import { AURA_TEAM_PRESET_PATH, planDesiredMcpConvergence } from "@tryaura/core";

import type { SetupBlocker } from "./planner.js";
import type { SetupStepContext } from "./types.js";

export interface SetupMcpPlan {
  readonly blockers: readonly SetupBlocker[];
  readonly manifest: AuraManifest;
  readonly manualSteps: readonly string[];
  readonly operations: readonly FileOperation[];
}

/** Converges every detected managed MCP writer and folds ownership into one desired manifest. */
export function planSetupMcp(
  context: SetupStepContext,
  desiredManifest: AuraManifest,
): SetupMcpPlan {
  if (context.selections.mcp === undefined) {
    return { blockers: [], manifest: desiredManifest, manualSteps: [], operations: [] };
  }

  let manifest: AuraManifest = {
    ...desiredManifest,
    mcpServers: context.selections.mcp.servers,
  };
  const presetPath = join(context.model.projectRoot ?? context.model.cwd, AURA_TEAM_PRESET_PATH);
  const blockers: SetupBlocker[] = context.mcpCatalog.missingRequiredIds.map((id) => ({
    path: presetPath,
    reason: `Required MCP catalog entry ${id} is not available from the installed plugins.`,
  }));
  const missingDefinitions = new Set(context.mcpCatalog.missingRequiredIds);
  const selectedCatalogIds = new Set(
    manifest.mcpServers.flatMap((server) =>
      server.catalogId === undefined ? [] : [server.catalogId],
    ),
  );
  const overriddenRequiredIds = new Set(context.selections.mcp.overriddenRequiredIds ?? []);
  // Only a run that actually resolved the preset knows what it requires. Rebuilding the override
  // list from an empty requirement set would erase a confirmed deviation whenever the preset
  // merely failed to fetch, and "offline" must not read the same as "the requirement is gone".
  if (context.preset !== undefined) {
    manifest = withRequiredOverrides(
      manifest,
      context.mcpCatalog.requiredIds,
      overriddenRequiredIds,
    );
  }
  for (const id of context.mcpCatalog.requiredIds) {
    if (
      !missingDefinitions.has(id) &&
      !selectedCatalogIds.has(id) &&
      !overriddenRequiredIds.has(id)
    ) {
      blockers.push({ path: presetPath, reason: unconfiguredRequirement(context, id) });
    }
  }
  const operations: FileOperation[] = [];

  for (const entry of context.appCatalog) {
    if (
      entry.kind !== "detected" ||
      !entry.supportsMcp ||
      manifest.apps[entry.app.adapterId]?.managed !== true
    ) {
      continue;
    }
    const planned = planDesiredMcpConvergence(context.model, manifest, entry.app.adapterId);
    blockers.push(
      ...planned.blockers.map((blocker) => ({
        path: blocker.path ?? context.manifest.path,
        reason: blocker.message,
      })),
    );
    operations.push(...planned.operations);
    manifest = withMcpOwnership(manifest, entry.app.adapterId, planned.ownedNames);
  }

  return {
    blockers,
    manifest,
    manualSteps: credentialSteps(context, manifest),
    operations,
  };
}

function withRequiredOverrides(
  manifest: AuraManifest,
  requiredIds: ReadonlySet<string>,
  overriddenIds: ReadonlySet<string>,
): AuraManifest {
  const requiredMcpServers = [...requiredIds].filter((id) => overriddenIds.has(id));
  const previous = manifest.overrides;
  const { requiredMcpServers: _previousRequired, ...extension } = previous ?? {};
  const overrides =
    requiredMcpServers.length === 0 && Object.keys(extension).length === 0
      ? undefined
      : { ...extension, ...(requiredMcpServers.length === 0 ? {} : { requiredMcpServers }) };
  const { overrides: _previousOverrides, ...rest } = manifest;
  return overrides === undefined ? rest : { ...rest, overrides };
}

/**
 * Says which of the two ways a requirement went unmet happened, because the fix differs.
 *
 * A non-interactive run never proposes first-configuring a required server, so its blocker has to
 * name the run that can. Interactively the requirement can only be unmet because nothing eligible
 * was available to receive it.
 */
function unconfiguredRequirement(context: SetupStepContext, id: string): string {
  return context.interactive
    ? `Required MCP catalog entry ${id} could not be selected for a managed compatible application.`
    : `Required MCP catalog entry ${id} is not configured yet. Run setup interactively to choose its name, scope, and applications; later non-interactive runs re-apply what the manifest records.`;
}

function withMcpOwnership(
  manifest: AuraManifest,
  appId: string,
  names: readonly string[],
): AuraManifest {
  const previous = manifest.ownership[appId];
  return {
    ...manifest,
    ownership: {
      ...manifest.ownership,
      [appId]: {
        files: previous?.files ?? [],
        mcpServerNames: names,
      },
    },
  };
}

function credentialSteps(context: SetupStepContext, manifest: AuraManifest): readonly string[] {
  return manifest.mcpServers.flatMap((server) =>
    mcpEnvironmentVariableNames(server.transport).flatMap((name) => {
      if (context.isEnvironmentVariableSet(name)) {
        return [];
      }
      const catalog = context.model.availableMcpServers.find(
        (entry) => entry.id === server.catalogId,
      );
      const credential = catalog?.manifest.credentialEnv.find((entry) => entry.name === name);
      const guidance =
        credential === undefined
          ? `Set ${name} for custom MCP server ${server.name}.`
          : `${credential.description} Set it in ${name}.`;
      const setupUrl = credential?.setupUrl ?? catalog?.manifest.docsUrl;
      return [setupUrl === undefined ? guidance : `${guidance} Configure it at ${setupUrl}`];
    }),
  );
}
