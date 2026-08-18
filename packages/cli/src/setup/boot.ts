import type { AuraEffectiveConfig, Check, Environment, WorkspaceModel } from "@tryaura/aura-sdk";
import {
  applyRequiredMcpServers,
  buildWorkspaceModel,
  createFileReader,
  enabledChecks,
  readAuraManifest,
  resolveAuraManifestPath,
  type RequiredMcpProjection,
  type WorkspaceScan,
} from "@tryaura/core";

import { resolveRuntimeConfig, type RuntimeConfigResult } from "../runtime-config.js";
import type { SetupRequest } from "./setup.js";

/** Everything one setup run establishes before it asks the user anything. */
export type SetupBoot =
  | { readonly message: string; readonly status: "invalid" }
  | {
      readonly activeChecks: readonly Check[];
      readonly configured: Extract<RuntimeConfigResult, { status: "ready" }>;
      readonly effectiveModel: WorkspaceModel;
      readonly effectiveScan: WorkspaceScan;
      readonly projected: RequiredMcpProjection;
      readonly scan: WorkspaceScan;
      readonly status: "ready";
    };

/**
 * Resolves configuration, scans the machine, and projects preset requirements onto the model.
 *
 * All of it happens before the first prompt so a wizard never asks a question it will then have to
 * take back — an unusable manifest or an unresolvable preset stops the run while nothing has been
 * shown and nothing has been written.
 */
export async function bootSetup(
  request: SetupRequest,
  environment: Environment,
): Promise<SetupBoot> {
  const manifestPath = resolveAuraManifestPath(environment.homeDir);
  const manifest = readAuraManifest(manifestPath, await createFileReader().read(manifestPath));
  const configured = await resolveRuntimeConfig({
    cliLayer: request.cliLayer,
    cliReference: request.cliReference,
    defaultPreset: request.defaultPreset,
    defaults: request.defaults,
    environment,
    manifest,
    noCache: request.noCache,
    // Setup already lists skill directories over the network to build its pickers, so a remote
    // preset reference is not the thing that puts this command online.
    online: true,
    registry: request.registry,
  });
  if (configured.status === "invalid") {
    return configured;
  }

  const scan = await buildWorkspaceModel({
    adapters: request.registry.adapters,
    environment,
    mcpCatalog: request.registry.mcpServers,
    snippets: request.registry.snippets,
    skills: request.registry.skills,
  });
  const projected = applyRequiredMcpServers(scan.model, configured.config);
  return {
    activeChecks: enabledChecks(request.registry.checks, configured.config),
    configured,
    effectiveModel: projected.model,
    effectiveScan: {
      ...scan,
      diagnostics: [...scan.diagnostics, ...projected.diagnostics],
      model: projected.model,
    },
    projected,
    scan,
    status: "ready",
  };
}

/** Re-projects a rescan so the closing checklist reads the same virtual state the run planned. */
export function projectRescan(
  rescanned: WorkspaceScan,
  config: AuraEffectiveConfig,
): WorkspaceScan {
  const projection = applyRequiredMcpServers(rescanned.model, config);
  return {
    ...rescanned,
    diagnostics: [...rescanned.diagnostics, ...projection.diagnostics],
    model: projection.model,
  };
}
