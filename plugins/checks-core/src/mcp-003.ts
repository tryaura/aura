import { planMcpServerRemoval } from "@tryaura/core";
import {
  defineCheck,
  type DetectedFinding,
  type Finding,
  type FixPlan,
  type GuidedFixChoice,
  type McpProbeKind,
  type McpServer,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

const CHECK_ID = "MCP-003";

const EXPLAIN = `Aura checks stdio commands with filesystem-only PATH resolution. It never starts an MCP server during a check. Package launchers such as npx, uvx, and bunx are checked, but Aura does not guess whether the requested package is installed or cached.

Remote URLs are silent and generate no network traffic unless \`check --online\` is supplied. Online probes use short, bounded requests without configured authentication headers. Re-run with \`--fix --interactive\` to choose whether to repair or remove a server that definitely failed its probe.`;

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
  return model.mcpServers.flatMap((server) =>
    (server.probes ?? [])
      .filter((probe) => probe.status === "error")
      .map((probe): DetectedFinding => findingFor(server, probe.kind, probe.detail, model)),
  );
}

function findingFor(
  server: McpServer,
  kind: McpProbeKind,
  detail: string | undefined,
  model: WorkspaceModel,
): DetectedFinding {
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
