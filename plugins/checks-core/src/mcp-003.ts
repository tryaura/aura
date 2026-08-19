import { planMcpServerRemoval } from "@tryaura/core";
import {
  defineCheck,
  mcpEnvironmentVariableNames,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type GuidedFixChoice,
  type McpProbeKind,
  type McpProbeResult,
  type McpServer,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { cursorMcpStateFindings, mcpServerNameKey } from "./mcp-003-cursor.js";

const CHECK_ID = "MCP-003";

const EXPLAIN = `Aura checks stdio commands with filesystem-only PATH resolution, and starts no MCP server of its own. Package launchers such as npx, uvx, and bunx are checked, but Aura does not guess whether the requested package is installed or cached.

Remote URLs are silent and generate no network traffic unless \`check --online\` is supplied. Online probes use short, bounded requests without configured authentication headers, and they skip an endpoint whose credentials Aura stripped, because the remaining URL no longer addresses the configured server. A redirect to a private address is reported rather than followed. A timeout or a server-side fault is a warning, not an error: it may not repeat. Re-run with \`--fix --interactive\` to choose whether to repair or remove a server that definitely failed its probe. Cursor separately requires its MCP servers to be approved and enabled in its own settings, which no file records; Aura reads those states by running \`cursor-agent mcp list\` when that CLI is installed and identifies itself. The command is Cursor's, and it connects to servers to answer, so Aura runs it from your home directory: only your own global configuration takes part, never a \`.cursor/mcp.json\` committed to the repository you are in. Aura never approves, enables, or retries a server itself, and every state it reports this way is a warning. Aura also reports an informational reminder when a desired MCP transport references an unset environment variable. It retains only the variable name and whether it is set; credential values never enter the workspace model or report.`;

export const mcp003 = defineCheck({
  defaultSeverity: "error",
  detect: detectDeadServers,
  explain: EXPLAIN,
  fix: () => undefined,
  fixability: "guided",
  guidedFixes,
  id: CHECK_ID,
  scope: "global",
  title: "Configured MCP servers can be reached",
});

function detectDeadServers(model: WorkspaceModel): readonly DetectedFinding[] {
  const probeFindings: DetectedFinding[] = [];
  // Names a probe already proved dead, so Cursor's own "cannot connect" does not say it twice.
  const concretelyFailed = new Set<string>();
  for (const server of model.mcpServers) {
    const failed = (server.probes ?? []).filter((probe) => probe.status === "error");
    if (failed.length === 0) {
      continue;
    }
    concretelyFailed.add(mcpServerNameKey(server.appId, server.name));
    probeFindings.push(...failed.map((probe) => findingFor(server, probe, model)));
  }

  return [
    ...probeFindings,
    ...model.apps.flatMap((app) => cursorMcpStateFindings(app, concretelyFailed)),
    ...unsetEnvironmentFindings(model),
  ];
}

function unsetEnvironmentFindings(model: WorkspaceModel): readonly DetectedFinding[] {
  if (model.manifest.status !== "ready") {
    return [];
  }
  const availability = new Map(
    model.mcpEnvironmentVariables.map((variable) => [variable.name, variable.isSet]),
  );
  return model.manifest.value.mcpServers.flatMap((server, serverIndex) =>
    mcpEnvironmentVariableNames(server.transport).flatMap((variableName) => {
      if (availability.get(variableName) !== false) {
        return [];
      }
      const catalog = model.availableMcpServers.find(
        (candidate) => candidate.id === server.catalogId,
      );
      const credential = catalog?.manifest.credentialEnv.find(
        (candidate) => candidate.name === variableName,
      );
      const details = credentialDetails(
        server.name,
        variableName,
        credential,
        catalog?.manifest.docsUrl,
      );
      const finding: DetectedFinding = {
        details,
        // Aura never holds a credential value, so setting the variable is the user's alone. The
        // check is guided for the transports it can repair; this reminder is not one of them.
        fixability: "manual",
        id: `environment:${String(serverIndex)}:${variableName}`,
        locations: [{ path: model.manifest.path }],
        message: `MCP server ${server.name} needs environment variable ${variableName}.`,
        metadata: {
          kind: "environment",
          serverName: server.name,
          serverScope: server.scope,
          variableName,
        },
        severity: "info",
      };
      return [finding];
    }),
  );
}

function credentialDetails(
  serverName: string,
  variableName: string,
  credential: { readonly description: string; readonly setupUrl?: string | undefined } | undefined,
  docsUrl: string | undefined,
): string {
  const guidance =
    credential?.description ??
    `Set ${variableName} to the credential required by custom MCP server ${serverName}.`;
  const url = credential?.setupUrl ?? docsUrl;
  return url === undefined ? guidance : `${guidance} Setup: ${url}`;
}

function findingFor(
  server: McpServer,
  probe: McpProbeResult,
  model: WorkspaceModel,
): DetectedFinding {
  const kind: McpProbeKind = probe.kind;
  const detail = probe.detail;
  const app = model.apps.find((candidate) => candidate.adapterId === server.appId);
  const path = app?.sourceFiles.find((file) => file.spec.id === server.sourceId)?.spec.path;
  const displayName = app?.displayName ?? server.appId;
  const reason =
    kind === "command" && server.transport.type === "stdio"
      ? ` because command ${server.transport.command} was not found`
      : "";
  return {
    ...(detail === undefined ? {} : { details: detail }),
    id: `${server.appId}:${server.sourceId}:${server.scope}:${server.name}:${kind}`,
    ...(path === undefined ? {} : { locations: [{ path }] }),
    message: `MCP server ${server.name} in ${displayName} cannot be reached${reason}.`,
    metadata: {
      appId: server.appId,
      kind,
      serverName: server.name,
      serverScope: server.scope,
      sourceId: server.sourceId,
    },
    // A timeout or a server's own fault may not repeat, and a run that exits non-zero on a network
    // blip is a run people stop making with `--online`.
    ...(probe.transient === true ? { severity: "warn" as const } : {}),
  };
}

function guidedFixes(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  const server = findingServer(finding, model);
  const kind = finding.metadata?.["kind"];
  if (server === undefined || (kind !== "command" && kind !== "url")) {
    return [];
  }
  return [repairChoice(server, kind, model), removeChoice(server, model)];
}

function repairChoice(
  server: McpServer,
  kind: "command" | "url",
  model: WorkspaceModel,
): GuidedFixChoice {
  const path = sourcePath(server, model);
  const location = path ?? "the application's MCP configuration";
  const steps =
    kind === "command" && server.transport.type === "stdio"
      ? [
          `Install or restore command ${server.transport.command}, or repair server ${server.name} in ${location}.`,
          "Run `aura check` again.",
        ]
      : [
          `Verify server ${server.name}'s URL, service, proxy, and TLS configuration in ${location}.`,
          "Run `aura check --online` again.",
        ];
  return {
    id: "repair",
    label: "Repair server",
    plan: {
      manualSteps: steps,
      operations: [],
      summary: `Repair MCP server ${server.name}.`,
    },
  };
}

function removeChoice(server: McpServer, model: WorkspaceModel): GuidedFixChoice {
  const removal = planMcpServerRemoval(model, server);
  if (removal.plan !== undefined && removal.blockers.length === 0) {
    return {
      id: "remove",
      label: "Remove server",
      plan: {
        ...removal.plan,
        summary: `Remove MCP server ${server.name} from ${server.appId}.`,
      },
    };
  }

  return {
    id: "remove",
    label: "Remove server",
    plan: manualRemoval(
      server,
      model,
      removal.blockers.map((blocker) => blocker.message),
    ),
  };
}

function manualRemoval(
  server: McpServer,
  model: WorkspaceModel,
  blockers: readonly string[],
): FixPlan {
  const path = sourcePath(server, model) ?? "the application's MCP configuration file";
  const selected =
    model.manifest.status === "ready" &&
    model.manifest.value.mcpServers.some(
      (entry) =>
        entry.name === server.name &&
        entry.scope === server.scope &&
        entry.apps.includes(server.appId),
    );
  return {
    manualSteps: [
      ...blockers,
      `Remove MCP server ${server.name} from ${path}.`,
      ...(selected
        ? [
            `Remove ${server.appId} from server ${server.name}'s apps in ${model.manifest.path}; delete that manifest server entry if no applications remain.`,
          ]
        : []),
      "Run `aura check` again, adding `--online` if this was a URL failure.",
    ],
    operations: [],
    summary: `Remove MCP server ${server.name} manually.`,
  };
}

// fallow-ignore-next-line complexity -- validates every untrusted metadata identity field before lookup.
function findingServer(finding: Finding, model: WorkspaceModel): McpServer | undefined {
  if (finding.checkId !== CHECK_ID) {
    return undefined;
  }
  const appId = finding.metadata?.["appId"];
  const name = finding.metadata?.["serverName"];
  const scope = finding.metadata?.["serverScope"];
  const sourceId = finding.metadata?.["sourceId"];
  if (
    typeof appId !== "string" ||
    typeof name !== "string" ||
    (scope !== "global" && scope !== "project") ||
    typeof sourceId !== "string"
  ) {
    return undefined;
  }
  return model.mcpServers.find(
    (server) =>
      server.appId === appId &&
      server.name === name &&
      server.scope === scope &&
      server.sourceId === sourceId,
  );
}

function sourcePath(server: McpServer, model: WorkspaceModel): string | undefined {
  return model.apps
    .find((app) => app.adapterId === server.appId)
    ?.sourceFiles.find((file) => file.spec.id === server.sourceId)?.spec.path;
}
