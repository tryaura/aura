import { createHash } from "node:crypto";

import { isEnvironmentVariableName } from "./mcp-secret-heuristics.js";
import type { McpSecretSighting, McpSecretSightingDraft } from "./mcp-secret.js";

/** Marks a name that already carries a disambiguating suffix, so it is never suffixed twice. */
const HASHED_SUFFIX_PATTERN = /_[0-9A-F]{8}$/u;

/** Chooses one suggested environment name per draft, disambiguating collisions within the entry. */
export function nameSightings(
  drafts: readonly McpSecretSightingDraft[],
): readonly McpSecretSighting[] {
  const baseNames = drafts.map((draft) => draft.preferredEnvName ?? suggestedName(draft));
  const counts = new Map<string, number>();
  for (const name of baseNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return drafts.map((draft, index) => {
    const base = baseNames[index] ?? "MCP_SECRET";
    const suggestedEnvName =
      (counts.get(base) ?? 0) > 1
        ? `${base}_${safeFieldHash(draft.context.serverName, draft.field)}`
        : base;
    return {
      appId: draft.context.appId,
      field: draft.field,
      locator: draft.locator,
      recordPath: draft.context.recordPath,
      scope: draft.context.scope,
      serverName: draft.context.serverName,
      sourceId: draft.context.sourceId,
      suggestedEnvName,
    };
  });
}

/** Adds deterministic suffixes when generated names collide within one configuration source. */
export function resolveMcpSecretNameCollisions(
  sightings: readonly McpSecretSighting[],
): readonly McpSecretSighting[] {
  const counts = new Map<string, number>();
  for (const sighting of sightings) {
    counts.set(collisionKey(sighting), (counts.get(collisionKey(sighting)) ?? 0) + 1);
  }
  return sightings.map((sighting) => {
    // A name the user already exports is the name the application already reads: suffixing it
    // would rewrite the entry to point at a variable nobody sets.
    const retained =
      sighting.locator.kind === "env" &&
      sighting.locator.name === sighting.suggestedEnvName &&
      isEnvironmentVariableName(sighting.locator.name);
    if (
      (counts.get(collisionKey(sighting)) ?? 0) < 2 ||
      retained ||
      HASHED_SUFFIX_PATTERN.test(sighting.suggestedEnvName)
    ) {
      return sighting;
    }
    return {
      ...sighting,
      suggestedEnvName: `${sighting.suggestedEnvName}_${safeFieldHash(sighting.serverName, sighting.field)}`,
    };
  });
}

function collisionKey(sighting: McpSecretSighting): string {
  return `${sighting.sourceId}\0${sighting.suggestedEnvName}`;
}

function suggestedName(draft: McpSecretSightingDraft): string {
  const safe = `${draft.context.serverName}_${draft.field}`
    .replace(/[^A-Za-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
  if (isEnvironmentVariableName(safe)) {
    return safe;
  }
  return `MCP_${safe.length === 0 ? "SECRET" : safe}`;
}

/** A stable suffix derived from the field's identity alone, never from the value it held. */
function safeFieldHash(serverName: string, field: string): string {
  return createHash("sha256")
    .update(`${serverName}:${field}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
}
