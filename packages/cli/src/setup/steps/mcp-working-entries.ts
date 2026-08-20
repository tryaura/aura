import type { AuraManifestMcpServer } from "@tryaura/aura-sdk";

import type { McpSetupCatalogEntry } from "../mcp-catalog.js";
import type { SetupStepContext } from "../types.js";
import type { WorkingMcpEntry } from "./mcp-step-types.js";

/**
 * The rows the MCP picker works from: the catalog, plus any server this run already settled on.
 *
 * A custom server has no catalog entry to hang off, so it comes back as a row of its own — which is
 * what lets a re-entered step show what the last pass added instead of losing it.
 */
export function workingEntries(context: SetupStepContext): WorkingMcpEntry[] {
  const previous = context.selections.mcp?.servers;
  const entries = context.mcpCatalog.entries.map((entry): WorkingMcpEntry => ({
    ...entry,
    selectedServer: previous?.find((server) => matchesEntry(server, entry)) ?? entry.existing,
  }));
  for (const server of previous ?? []) {
    if (entries.some((entry) => entry.selectedServer === server || matchesEntry(server, entry))) {
      continue;
    }
    entries.push({
      existing: server,
      key: nextCustomKey(entries),
      required: false,
      selectedServer: server,
    });
  }
  return entries;
}

function matchesEntry(server: AuraManifestMcpServer, entry: McpSetupCatalogEntry): boolean {
  const existing = entry.existing;
  if (existing !== undefined) {
    return (
      existing.catalogId === server.catalogId &&
      existing.name === server.name &&
      existing.scope === server.scope
    );
  }
  return entry.catalog?.id === server.catalogId;
}

export function nextCustomKey(entries: readonly WorkingMcpEntry[]): string {
  let index = entries.length;
  while (entries.some((entry) => entry.key === `custom:${String(index)}`)) {
    index += 1;
  }
  return `custom:${String(index)}`;
}

/**
 * A default name no other row has taken.
 *
 * Two servers cannot share one name in one application and scope — the manifest refuses to record
 * it — so seeding every custom server with `custom` would turn "add two, accept the defaults" into
 * a plan the manifest declines to hold.
 */
export function nextCustomName(entries: readonly WorkingMcpEntry[]): string {
  const taken = new Set(
    entries.flatMap((entry) => {
      const name = entry.selectedServer?.name ?? entry.existing?.name;
      return name === undefined ? [] : [name];
    }),
  );
  if (!taken.has("custom")) {
    return "custom";
  }
  let index = 2;
  while (taken.has(`custom-${String(index)}`)) {
    index += 1;
  }
  return `custom-${String(index)}`;
}
