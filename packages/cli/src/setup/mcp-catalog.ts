import type {
  AuraManifestMcpServer,
  AuraTeamPreset,
  ResolvedMcpServerDef,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import type { PluginRegistry } from "@tryaura/core";

/** One picker row assembled from a catalog definition and/or configured manifest entry. */
export interface McpSetupCatalogEntry {
  readonly catalog?: ResolvedMcpServerDef | undefined;
  readonly existing?: AuraManifestMcpServer | undefined;
  readonly key: string;
  readonly required: boolean;
  readonly sourceName?: string | undefined;
}

/** Fully merged MCP picker input for one setup run. */
export interface McpSetupCatalog {
  readonly entries: readonly McpSetupCatalogEntry[];
  readonly missingRequiredIds: readonly string[];
  readonly requiredIds: ReadonlySet<string>;
}

interface McpSetupCatalogInputs {
  readonly model: WorkspaceModel;
  readonly preset: AuraTeamPreset | undefined;
  readonly registry: PluginRegistry;
}

/** Merges catalog definitions, preset requirements, and existing desired-state entries. */
// fallow-ignore-next-line complexity -- merges three provenance sources without losing duplicates.
export function createMcpSetupCatalog(inputs: McpSetupCatalogInputs): McpSetupCatalog {
  const existing =
    inputs.model.manifest.status === "ready" ? inputs.model.manifest.value.mcpServers : [];
  const requiredIds = new Set(inputs.preset?.requiredMcpServers ?? []);
  const catalogById = new Map(inputs.model.availableMcpServers.map((entry) => [entry.id, entry]));
  const entries: McpSetupCatalogEntry[] = [];
  const usedExisting = new Set<number>();

  for (const catalog of inputs.model.availableMcpServers) {
    const matches = existing
      .map((server, index) => ({ index, server }))
      .filter(({ server }) => server.catalogId === catalog.id);
    const owner = inputs.registry.ownerOf("mcp-server", catalog.id);
    if (matches.length === 0) {
      entries.push({
        catalog,
        key: `catalog:${catalog.id}`,
        required: requiredIds.has(catalog.id),
        sourceName: owner?.name,
      });
      continue;
    }
    for (const match of matches) {
      usedExisting.add(match.index);
      entries.push({
        catalog,
        existing: match.server,
        key: `manifest:${String(match.index)}`,
        required: requiredIds.has(catalog.id),
        sourceName: owner?.name,
      });
    }
  }

  for (const [index, server] of existing.entries()) {
    if (usedExisting.has(index)) {
      continue;
    }
    const catalog = server.catalogId === undefined ? undefined : catalogById.get(server.catalogId);
    entries.push({
      ...(catalog === undefined ? {} : { catalog }),
      existing: server,
      key: `manifest:${String(index)}`,
      required: server.catalogId !== undefined && requiredIds.has(server.catalogId),
      sourceName:
        server.catalogId === undefined
          ? undefined
          : inputs.registry.ownerOf("mcp-server", server.catalogId)?.name,
    });
  }

  entries.sort(compareEntries);
  const missingRequiredIds = [...requiredIds]
    .filter((id) => !catalogById.has(id))
    .sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    entries: Object.freeze(entries),
    missingRequiredIds: Object.freeze(missingRequiredIds),
    requiredIds,
  });
}

function compareEntries(left: McpSetupCatalogEntry, right: McpSetupCatalogEntry): number {
  if (left.required !== right.required) {
    return left.required ? -1 : 1;
  }
  const leftConfigured = left.existing !== undefined;
  const rightConfigured = right.existing !== undefined;
  if (leftConfigured !== rightConfigured) {
    return leftConfigured ? -1 : 1;
  }
  return entryName(left).localeCompare(entryName(right));
}

/** User-facing name used by the picker and deterministic sorting. */
export function mcpCatalogEntryName(entry: McpSetupCatalogEntry): string {
  return entryName(entry);
}

function entryName(entry: McpSetupCatalogEntry): string {
  return entry.catalog?.manifest.name ?? entry.existing?.name ?? entry.key;
}
