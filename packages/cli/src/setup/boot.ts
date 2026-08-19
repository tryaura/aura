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
import { establishRepoPresetTrust } from "./repo-trust.js";
import type { SetupRequest } from "./setup.js";
import { bootRepoPresetTrust } from "./trust-record.js";
import type { SetupRepoPresetContext } from "./types.js";

/** Everything one setup run establishes before it asks the user anything else. */
export type SetupBoot =
  | { readonly message: string; readonly status: "invalid" }
  | { readonly status: "aborted" }
  | {
      readonly activeChecks: readonly Check[];
      readonly configured: Extract<RuntimeConfigResult, { status: "ready" }>;
      readonly effectiveModel: WorkspaceModel;
      readonly effectiveScan: WorkspaceScan;
      readonly projected: RequiredMcpProjection;
      /** How this run resolved the repository preset, including whether trust reached disk. */
      readonly repoPreset?: SetupRepoPresetContext | undefined;
      readonly scan: WorkspaceScan;
      readonly status: "ready";
    };

/**
 * Resolves configuration, scans the machine, and projects preset requirements onto the model.
 *
 * All of it happens before the first wizard prompt so the wizard never asks a question it will
 * then have to take back — an unusable manifest or an unresolvable preset stops the run while
 * nothing has been shown and nothing has been written. Repository preset trust is the exception on
 * both counts: its answer decides whether the repo layer joins the configuration at all, so the
 * confirmation must precede resolution, and an accepted answer is written here, before the wizard
 * opens, so that backing out of a wizard step does not discard a security decision the user has
 * already made and get them asked again. The read-only manifest check runs before the prompt so it
 * is never asked for a run that is already dead.
 *
 * The full scan stays behind every cheap early exit. It supplies the canonical model the trust
 * write needs, but an invalid manifest, an aborted trust prompt, or invalid configuration should
 * not scan every adapter and package manifest first.
 */
export async function bootSetup(
  request: SetupRequest,
  environment: Environment,
): Promise<SetupBoot> {
  const reader = createFileReader();
  const homeDir = (await reader.realPath(environment.homeDir)) ?? environment.homeDir;
  const manifestPath = resolveAuraManifestPath(homeDir);
  const manifest = readAuraManifest(manifestPath, await reader.read(manifestPath));
  if (manifest.status === "read-only") {
    return { message: manifest.problem.message, status: "invalid" };
  }
  const trust = await establishRepoPresetTrust({
    environment,
    interactive: request.interactive,
    io: request.io,
    manifest,
  });
  if (trust.kind === "aborted") {
    return { status: "aborted" };
  }
  const configured = await resolveRuntimeConfig({
    acceptedRepoPresetHash: trust.acceptedHash,
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
  // After resolution, because only then is it known whether the layer the prompt described is the
  // layer this run applied — a file rewritten between the two reads leaves it held.
  const trusted = await bootRepoPresetTrust(request, configured, trust.acceptedHash, scan);
  const projected = applyRequiredMcpServers(trusted.scan.model, configured.config);
  return {
    activeChecks: enabledChecks(request.registry.checks, configured.config),
    configured,
    effectiveModel: projected.model,
    effectiveScan: {
      ...trusted.scan,
      diagnostics: [...trusted.scan.diagnostics, ...projected.diagnostics],
      model: projected.model,
    },
    projected,
    ...(trusted.repoPreset === undefined ? {} : { repoPreset: trusted.repoPreset }),
    scan: trusted.scan,
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
