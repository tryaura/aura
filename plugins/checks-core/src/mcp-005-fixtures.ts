import { CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_SOURCE_IDS } from "@tryaura/adapter-claude-code";
import { CODEX_ADAPTER_ID, CODEX_SOURCE_IDS } from "@tryaura/adapter-codex";
import { CURSOR_ADAPTER_ID, CURSOR_SOURCE_IDS } from "@tryaura/adapter-cursor";
import type {
  AppModel,
  AuraManifest,
  AuraManifestMcpServer,
  McpConvergenceBlocker,
  McpServer,
  Scope,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import type { AppMcpConvergence } from "@tryaura/core/testing";

import { app, model } from "./testing.js";

/** The transport every fixture agrees on, so drift never stands in for placement. */
const TRANSPORT = { args: ["-y", "@example/docs"], command: "npx", type: "stdio" } as const;

/** A Codex source id no adapter declares, standing in for a non-canonical project file. */
const CODEX_PROJECT_SOURCE_ID = "codex.mcp.project";

/** One misplaced entry per official adapter and direction, with whether Aura can move it itself. */
export interface PlacementCase {
  readonly appId: string;
  readonly automatic: boolean;
  readonly expectedScope: Scope;
  readonly sourceId: string;
}

export const PLACEMENTS: readonly PlacementCase[] = [
  {
    appId: CLAUDE_CODE_ADAPTER_ID,
    automatic: true,
    expectedScope: "global",
    sourceId: CLAUDE_CODE_SOURCE_IDS.mcpProject,
  },
  {
    appId: CURSOR_ADAPTER_ID,
    automatic: true,
    expectedScope: "global",
    sourceId: CURSOR_SOURCE_IDS.mcpProject,
  },
  {
    appId: CODEX_ADAPTER_ID,
    automatic: false,
    expectedScope: "global",
    sourceId: CODEX_PROJECT_SOURCE_ID,
  },
];

export interface PlacementWorkspaceOptions {
  readonly appId: string;
  /** Makes the application's convergence planner refuse, as an unreadable file would. */
  readonly blockers?: readonly McpConvergenceBlocker[];
  readonly desired?: readonly AuraManifestMcpServer[];
  readonly expectedScope: Scope;
  readonly ledger: readonly string[];
  readonly managed?: boolean;
  readonly servers: readonly McpServer[];
}

export function workspaceFor(options: PlacementWorkspaceOptions): WorkspaceModel {
  const sources = sourcesFor(options.appId, options.servers);
  return model({
    apps: [
      app({
        adapterId: options.appId,
        displayName: displayName(options.appId),
        mcpConvergence: convergenceFor(sources, options.blockers ?? []),
        mcpServers: options.servers,
        sources,
      }),
    ],
    manifest: {
      exists: true,
      path: "/home/dev/agents/aura.json",
      status: "ready",
      value: manifest(
        options.appId,
        options.desired ?? [desired(options.appId)],
        options.ledger,
        options.managed ?? true,
      ),
    },
  });
}

export function desired(appId: string): AuraManifestMcpServer {
  return { apps: [appId], name: "docs", transport: { ...TRANSPORT } };
}

export function server(appId: string, sourceId: string, scope: Scope): McpServer {
  return { appId, name: "docs", scope, sourceId, transport: { ...TRANSPORT } };
}

export function opposite(scope: Scope): Scope {
  return scope === "global" ? "project" : "global";
}

function manifest(
  appId: string,
  mcpServers: readonly AuraManifestMcpServer[],
  ledger: readonly string[],
  managed: boolean,
): AuraManifest {
  return {
    apps: { [appId]: { managed } },
    mcpServers,
    ownership: { [appId]: { files: [], mcpServerNames: ledger } },
    schemaVersion: 1,
    skills: [],
    snippets: [],
  };
}

/**
 * The application's declared MCP files, plus whatever file the configured entries came from.
 *
 * The canonical specs are listed first and duplicates by id are dropped, so an entry that names a
 * canonical spec inherits that spec's real path and scope — which is what makes a Claude Code
 * `projects` entry (project scope, global spec) representable at all.
 */
function sourcesFor(appId: string, servers: readonly McpServer[]): AppModel["sourceFiles"] {
  return uniqueSources([
    ...canonicalSources(appId),
    ...servers.map((configured) =>
      source(configured.sourceId, configured.scope, pathFor(configured.sourceId)),
    ),
  ]);
}

function canonicalSources(appId: string): AppModel["sourceFiles"] {
  if (appId === CLAUDE_CODE_ADAPTER_ID) {
    return [
      source(CLAUDE_CODE_SOURCE_IDS.mcp, "global", "/home/dev/.claude.json"),
      source(CLAUDE_CODE_SOURCE_IDS.mcpProject, "project", "/workspace/.mcp.json"),
    ];
  }
  if (appId === CURSOR_ADAPTER_ID) {
    return [
      source(CURSOR_SOURCE_IDS.mcpGlobal, "global", "/home/dev/.cursor/mcp.json"),
      source(CURSOR_SOURCE_IDS.mcpProject, "project", "/workspace/.cursor/mcp.json"),
    ];
  }
  return [source(CODEX_SOURCE_IDS.mcp, "global", "/home/dev/.codex/config.toml")];
}

function uniqueSources(sources: AppModel["sourceFiles"]): AppModel["sourceFiles"] {
  const seen = new Set<string>();
  return sources.filter((candidate) => {
    if (seen.has(candidate.spec.id)) {
      return false;
    }
    seen.add(candidate.spec.id);
    return true;
  });
}

function source(id: string, scope: Scope, path: string): AppModel["sourceFiles"][number] {
  return { exists: true, pathKind: "file", spec: { id, kind: "mcp", optional: true, path, scope } };
}

function convergenceFor(
  sources: AppModel["sourceFiles"],
  blockers: readonly McpConvergenceBlocker[],
): AppMcpConvergence {
  return (entries) => ({
    blockers,
    operations:
      blockers.length > 0
        ? []
        : sources.map((candidate) => ({
            content: JSON.stringify(entries),
            path: candidate.spec.path,
            type: "write",
          })),
    ownedNames: entries.map((entry) => entry.name),
  });
}

function pathFor(sourceId: string): string {
  return sourceId === CODEX_PROJECT_SOURCE_ID
    ? "/workspace/.codex/config.toml"
    : `/fixture/${sourceId}`;
}

function displayName(appId: string): string {
  if (appId === CLAUDE_CODE_ADAPTER_ID) {
    return "Claude Code";
  }
  return appId === CURSOR_ADAPTER_ID ? "Cursor" : "Codex";
}
