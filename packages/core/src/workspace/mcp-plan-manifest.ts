import type { AuraManifest, McpServer, OwnedServerEntry, WorkspaceModel } from "@tryaura/aura-sdk";

/**
 * Merges preset-required servers under the manifest's own, keyed by name.
 *
 * The manifest is written last and wins, matching the layer precedence everywhere else. A preset
 * that requires a server the user already configured must not silently repoint its transport:
 * a required entry fills a gap, it does not overrule a decision the user recorded.
 */
export function desiredEntries(
  model: WorkspaceModel,
  manifest: AuraManifest,
  appId: string,
): readonly OwnedServerEntry[] {
  const result = new Map<string, OwnedServerEntry>();
  for (const server of [...(model.requiredMcpServers ?? []), ...manifest.mcpServers]) {
    if (server.apps.includes(appId)) {
      result.set(server.name, {
        name: server.name,
        transport: server.transport,
      });
    }
  }
  return Object.freeze([...result.values()]);
}

/** Restates one application's ownership ledger without disturbing the files it also records. */
export function withOwnership(
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

/** Drops one application from a desired server, and the entry entirely once nobody wants it. */
export function withoutServer(manifest: AuraManifest, server: McpServer): AuraManifest {
  const mcpServers = manifest.mcpServers.flatMap((entry) => {
    if (entry.name !== server.name) {
      return [entry];
    }
    const apps = entry.apps.filter((appId) => appId !== server.appId);
    return apps.length === 0 ? [] : [{ ...entry, apps }];
  });
  return { ...manifest, mcpServers };
}
