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
  /** True for a definition the trusted repository preset provides; sorts ahead of the rest. */
  readonly repo?: boolean | undefined;
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
        ...(isRepoCatalogId(catalog.id) ? { repo: true } : {}),
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
        ...(isRepoCatalogId(catalog.id) ? { repo: true } : {}),
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
      ...(server.catalogId !== undefined && isRepoCatalogId(server.catalogId)
        ? { repo: true }
        : {}),
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

/**
 * Required rows first (they carry blocker semantics whoever asked for them), then this
 * repository's own definitions, then configured rows, then everything else by name. Repo rows
 * lead the optional block — they are what a person running setup inside the repository came for —
 * without outranking a requirement they did not make.
 */
function compareEntries(left: McpSetupCatalogEntry, right: McpSetupCatalogEntry): number {
  if (left.required !== right.required) {
    return left.required ? -1 : 1;
  }
  const leftRepo = left.repo === true;
  const rightRepo = right.repo === true;
  if (leftRepo !== rightRepo) {
    return leftRepo ? -1 : 1;
  }
  const leftConfigured = left.existing !== undefined;
  const rightConfigured = right.existing !== undefined;
  if (leftConfigured !== rightConfigured) {
    return leftConfigured ? -1 : 1;
  }
  return entryName(left).localeCompare(entryName(right));
}

/** The `repo/` namespace is reserved against plugins, so the prefix alone is provenance. */
function isRepoCatalogId(id: string): boolean {
  return id.startsWith("repo/");
}

/** User-facing name used by the picker and deterministic sorting. */
export function mcpCatalogEntryName(entry: McpSetupCatalogEntry): string {
  return entryName(entry);
}

function entryName(entry: McpSetupCatalogEntry): string {
  return entry.catalog?.manifest.name ?? entry.existing?.name ?? entry.key;
}
