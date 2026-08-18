import { isDeepStrictEqual } from "node:util";

import {
  McpWriteError,
  normalizeMcpServerDefinition,
  type McpConvergenceBlocker,
  type McpTransport,
  type OwnedServerEntry,
  type Scope,
} from "@tryaura/aura-sdk";

import type { AppMcpState } from "./mcp-convergence.js";

/**
 * Splits desired servers into the ones Aura may write and the collisions a person has to settle.
 *
 * Scope is part of identity here. A server named `docs` in a project `.mcp.json` is not the `docs`
 * the manifest wants in user-level configuration, and treating them as one either blocks a write
 * that would not have collided or skips one that never happened.
 */
export function classifyDesired(
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
  state: AppMcpState,
): {
  readonly blockers: readonly McpConvergenceBlocker[];
  readonly owned: readonly OwnedServerEntry[];
} {
  const ledger = new Set(ledgerNames);
  const owned: OwnedServerEntry[] = [];
  const blockers: McpConvergenceBlocker[] = [];
  for (const entry of desired) {
    const blocker = collisionBlocker(entry, ledger, state);
    if (blocker === "owned") {
      owned.push(entry);
    } else if (blocker !== undefined) {
      blockers.push(blocker);
    }
  }
  return { blockers, owned };
}

/** `owned` to write it, a blocker to refuse, `undefined` when the config already satisfies it. */
function collisionBlocker(
  entry: OwnedServerEntry,
  ledger: ReadonlySet<string>,
  state: AppMcpState,
): McpConvergenceBlocker | "owned" | undefined {
  if (ledger.has(entry.name)) {
    return "owned";
  }
  const sameName = (candidate: { readonly name: string; readonly scope: Scope }): boolean =>
    candidate.name === entry.name && candidate.scope === entry.scope;

  const unusable = state.unusable.find(sameName);
  if (unusable !== undefined) {
    return {
      message:
        unusable.reason === "disabled"
          ? `MCP server ${entry.name} is already declared in this application's ${entry.scope} configuration but is turned off there. Remove or enable it, then run the fix again.`
          : `MCP server ${entry.name} is already declared in this application's ${entry.scope} configuration in a form Aura does not recognize, so Aura left it unchanged.`,
      scope: entry.scope,
      sourceId: unusable.sourceId,
    };
  }

  const existing = state.servers.filter(sameName);
  if (existing.length === 0) {
    return "owned";
  }
  const normalized = normalizeDesired(entry);
  if ("message" in normalized) {
    return normalized;
  }
  return existing.every((server) => isDeepStrictEqual(server.transport, normalized.transport))
    ? undefined
    : {
        message: `MCP server ${entry.name} already exists outside Aura's ownership ledger and differs from the manifest.`,
        scope: entry.scope,
      };
}

/**
 * Normalizes one desired transport, reporting a manifest Aura refuses to write as a blocker.
 *
 * The manifest is a file a person can edit. One that has acquired a credential literal is not a
 * crash in a check's `detect`; it is something to say out loud and decline to propagate.
 */
function normalizeDesired(
  entry: OwnedServerEntry,
): McpConvergenceBlocker | { readonly transport: McpTransport } {
  try {
    return { transport: normalizeMcpServerDefinition(entry.transport) };
  } catch (error) {
    return {
      message:
        error instanceof McpWriteError
          ? `MCP server ${entry.name} cannot be written as the manifest defines it: ${error.message}`
          : `MCP server ${entry.name} has a manifest definition Aura cannot represent.`,
      scope: entry.scope,
    };
  }
}
