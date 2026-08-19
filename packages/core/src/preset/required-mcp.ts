import type {
  AuraEffectiveConfig,
  AuraManifest,
  OverriddenRequiredMcpServer,
  RequiredMcpServer,
  ResolvedMcpServerDef,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";

const REQUIRED_MCP_DIAGNOSTIC_ID = "core/required-mcp-server";

/** The projected model and every requirement that could not be honoured, with the reason. */
export interface RequiredMcpProjection {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly model: WorkspaceModel;
}

/**
 * Projects preset-required catalog entries into virtual manifest desired state.
 *
 * A requirement the workspace cannot satisfy is dropped rather than forced, but never silently:
 * a preset that asks for a server and gets nothing must say so, or the user reads a clean run as
 * proof the requirement was met.
 */
// fallow-ignore-next-line complexity -- reports each independent reason one requirement cannot apply.
export function applyRequiredMcpServers(
  model: WorkspaceModel,
  config: AuraEffectiveConfig,
): RequiredMcpProjection {
  if (model.manifest.status !== "ready") {
    return { diagnostics: Object.freeze([]), model };
  }
  const manifest = model.manifest.value;
  const configured = new Set(
    manifest.mcpServers.map((server) => `${server.scope}\0${server.name}`),
  );
  const configuredCatalogIds = new Set(
    manifest.mcpServers.flatMap((server) =>
      server.catalogId === undefined ? [] : [server.catalogId],
    ),
  );
  const diagnostics: ScanDiagnostic[] = [];
  const required: RequiredMcpServer[] = [];
  const overridden: OverriddenRequiredMcpServer[] = [];
  const overrideIds = new Set(manifest.overrides?.requiredMcpServers ?? []);
  for (const selection of config.requiredMcpServers) {
    if (overrideIds.has(selection.value)) {
      overridden.push({ catalogId: selection.value, requiredBy: selection.provenance.label });
      continue;
    }
    if (configuredCatalogIds.has(selection.value)) {
      continue;
    }
    const catalog = model.availableMcpServers.find((candidate) => candidate.id === selection.value);
    if (catalog === undefined) {
      diagnostics.push(
        note(`is not in this run's MCP catalog, so it was skipped`, selection.value, selection),
      );
      continue;
    }
    const name = catalog.manifest.serverName;
    if (configured.has(`global\0${name}`)) {
      diagnostics.push(
        note(
          `is already configured as "${name}", so your own settings were kept`,
          catalog.id,
          selection,
        ),
      );
      continue;
    }
    const apps = supportedApps(model, manifest, catalog);
    if (apps.length === 0) {
      diagnostics.push(
        note(
          "has no managed application that supports it, so it was skipped",
          catalog.id,
          selection,
        ),
      );
      continue;
    }
    required.push(
      Object.freeze({
        apps: Object.freeze(apps),
        catalogId: catalog.id,
        name,
        requiredBy: selection.provenance.label,
        scope: "global",
        transport: catalog.manifest.transportTemplate,
      }),
    );
  }
  return {
    diagnostics: Object.freeze(diagnostics),
    model:
      required.length === 0 && overridden.length === 0
        ? model
        : Object.freeze({
            ...model,
            ...(overridden.length === 0
              ? {}
              : { overriddenRequiredMcpServers: Object.freeze(overridden) }),
            ...(required.length === 0 ? {} : { requiredMcpServers: Object.freeze(required) }),
          }),
  };
}

function supportedApps(
  model: WorkspaceModel,
  manifest: AuraManifest,
  catalog: ResolvedMcpServerDef,
): string[] {
  const supported = catalog.manifest.supportedApps;
  return model.apps
    .filter(
      (app) =>
        app.support.status === "supported" &&
        manifest.apps[app.adapterId]?.managed === true &&
        (supported === undefined || supported.includes(app.adapterId)),
    )
    .map((app) => app.adapterId);
}

function note(
  reason: string,
  id: string,
  selection: AuraEffectiveConfig["requiredMcpServers"][number],
): ScanDiagnostic {
  return {
    adapterId: REQUIRED_MCP_DIAGNOSTIC_ID,
    message: `MCP server "${id}" required by ${selection.provenance.label} ${reason}.`,
    phase: "read",
  };
}
