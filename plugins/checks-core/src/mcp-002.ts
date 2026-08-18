import { defineCheck, type DetectedFinding, type WorkspaceModel } from "@tryaura/aura-sdk";

import {
  configuredFor,
  convergenceFix,
  desiredMcpTargets,
  transportMatches,
  withBlockers,
  type DesiredMcpTarget,
} from "./mcp-common.js";

const EXPLAIN = `Aura compares each configured MCP transport with the credential-safe definition in the manifest. Commands and flag positions, environment-variable names, sanitized URLs, and header-variable names must agree across applications.

A server that stores a credential as a literal where the manifest names an environment variable counts as drift too, since the manifest asks for a reference and the configuration supplies a value. When a managed server drifts, Aura regenerates the application's complete managed MCP state from the manifest, so converging that case replaces the literal with a reference the variable has to supply. Credentials themselves are never copied into findings.`;

export const mcp002 = defineCheck({
  defaultSeverity: "warn",
  detect: detectDrift,
  explain: EXPLAIN,
  fix: convergenceFix,
  fixability: "auto",
  id: "MCP-002",
  scope: "global",
  title: "Managed MCP servers match the manifest definition",
});

function detectDrift(model: WorkspaceModel): readonly DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  const affected = new Set<string>();
  for (const target of desiredMcpTargets(model)) {
    const actual = configuredFor(model, target);
    const drifted = actual.filter((server) => !transportMatches(target, server));
    if (drifted.length === 0) {
      continue;
    }
    affected.add(target.appId);
    findings.push(
      driftFinding(
        target,
        drifted.some((server) => inlineCredential(server.transport)),
      ),
    );
  }

  // MCP-001 reports the blockers themselves; repeating them here would describe one obstruction
  // twice in identical words.
  return withBlockers(findings, affected, model, { report: false });
}

function driftFinding(target: DesiredMcpTarget, inline: boolean): DetectedFinding {
  return {
    ...(inline
      ? {
          details:
            "The configured entry supplies a credential directly where the manifest names an environment variable. Converging replaces the value with a reference to that variable, which must be exported for the server to start.",
        }
      : {}),
    id: `drift:${target.appId}:${target.name}`,
    message: inline
      ? `MCP server ${target.name} in ${target.appId} stores a credential inline; the manifest defines it as an environment reference.`
      : `MCP server ${target.name} in ${target.appId} differs from the Aura manifest.`,
    metadata: {
      appId: target.appId,
      kind: inline ? "inline-credential" : "drift",
      serverName: target.name,
    },
  };
}

function inlineCredential(transport: WorkspaceModel["mcpServers"][number]["transport"]): boolean {
  return transport.inlineCredentialValues === true;
}
