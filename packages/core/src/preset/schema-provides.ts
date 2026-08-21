import type { AuraTeamPresetProvides, McpServerManifest } from "@tryaura/aura-sdk";
import { parseMcpServerManifestValue } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { MAX_REPO_MCP_SERVERS } from "./repo-content-limits.js";

const REPO_MCP_ID_PATTERN = /^repo\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

/**
 * Collects the `provides` envelope of a repository preset.
 *
 * Content a preset authors reaches command lines and app configuration, so it may only arrive
 * from the file the user hash-trusted for this repository. Callers validating a downloaded or
 * bundled preset reject the field wholesale before this collector runs.
 */
export function collectProvides(value: unknown): AuraTeamPresetProvides | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return "$.provides: must be an object";
  }
  const servers = collectProvidedMcpServers(value["mcpServers"]);
  if (typeof servers === "string") {
    return servers;
  }
  return servers === undefined ? Object.freeze({}) : Object.freeze({ mcpServers: servers });
}

function collectProvidedMcpServers(
  value: unknown,
): readonly McpServerManifest[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "$.provides.mcpServers: must be an array of MCP server definitions";
  }
  if (value.length > MAX_REPO_MCP_SERVERS) {
    return `$.provides.mcpServers: must contain at most ${String(MAX_REPO_MCP_SERVERS)} definitions`;
  }
  const result: McpServerManifest[] = [];
  const ids = new Set<string>();
  const serverNames = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `$.provides.mcpServers[${String(index)}]`;
    const parsed = parseMcpServerManifestValue(candidate);
    if ("error" in parsed) {
      // Re-root the definition's own `$`-path under this entry so the problem stays addressable.
      return `${path}${parsed.error.path.slice(1)}: ${parsed.error.message}`;
    }
    if (!REPO_MCP_ID_PATTERN.test(parsed.value.id)) {
      return `${path}.id: must be namespaced "repo/<name>"`;
    }
    if (ids.has(parsed.value.id)) {
      return `${path}.id: must not duplicate another provided server id`;
    }
    if (serverNames.has(parsed.value.serverName)) {
      return `${path}.serverName: must not duplicate another provided server name`;
    }
    ids.add(parsed.value.id);
    serverNames.add(parsed.value.serverName);
    result.push(parsed.value);
  }
  return Object.freeze(result);
}
