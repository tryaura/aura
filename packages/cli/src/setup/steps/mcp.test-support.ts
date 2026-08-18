import type { ResolvedMcpServerDef, WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import type { AppCatalogEntry } from "../catalog.js";
import type { McpSetupCatalog } from "../mcp-catalog.js";
import { emptySkillCatalog, emptySnippetCatalog } from "../testing.js";
import type { SetupStepContext } from "../types.js";
import type { WizardAnswer, WizardAnswers } from "../wizard-types.js";
import type { mcpStep } from "./mcp.js";

/** The configured names in order, for assertions about identity rather than transport. */
export function serverNames(result: Awaited<ReturnType<typeof mcpStep.gather>>): readonly string[] {
  if (typeof result === "symbol") {
    throw new Error("Expected the step to resolve with selections.");
  }
  return (result.mcp?.servers ?? []).map((server) => server.name);
}

export interface ContextOptions {
  readonly interactive?: boolean | undefined;
}

export function context(
  definitions: readonly ResolvedMcpServerDef[],
  requiredIds: readonly string[] = [],
  options: ContextOptions = {},
): SetupStepContext {
  const manifest = readyManifest();
  const model = createWorkspaceModel({
    availableMcpServers: definitions,
    apps: apps().flatMap((entry) => (entry.kind === "detected" ? [entry.app] : [])),
    manifest,
    sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
  });
  const mcpCatalog: McpSetupCatalog = {
    entries: definitions.map((catalog) => ({
      catalog,
      key: `catalog:${catalog.id}`,
      required: requiredIds.includes(catalog.id),
      sourceName: "Fixture plugin",
    })),
    missingRequiredIds: [],
    requiredIds: new Set(requiredIds),
  };
  return {
    appCatalog: apps(),
    interactive: options.interactive ?? true,
    isEnvironmentVariableSet: () => false,
    manifest,
    mcpCatalog,
    model,
    selections: {},
    skillCatalog: emptySkillCatalog(),
    snippetCatalog: emptySnippetCatalog(),
  };
}

function apps(): readonly AppCatalogEntry[] {
  return [
    detectedApp("claude-code", "Claude Code"),
    detectedApp("codex", "Codex"),
    detectedApp("cursor", "Cursor"),
  ];
}

function detectedApp(adapterId: string, displayName: string): AppCatalogEntry {
  return {
    app: {
      adapterId,
      detection: { installed: true, version: "1.0.0" },
      displayName,
      instructionFiles: [],
      mcpServers: [],
      skills: [],
      sourceFiles: [],
      support: { status: "supported", supportedRange: ">=1", version: "1.0.0" },
    },
    kind: "detected",
    supportsMcp: true,
    supportsSkills: false,
  };
}

function readyManifest(): Extract<WorkspaceModel["manifest"], { readonly status: "ready" }> {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: {
        "claude-code": { managed: true },
        codex: { managed: true },
        cursor: { managed: true },
      },
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    },
  };
}

export function definition(
  id: string,
  name: string,
  serverName: string,
  supportedApps: readonly string[] = ["claude-code", "codex", "cursor"],
): ResolvedMcpServerDef {
  const description = `${name} MCP server.`;
  return {
    description,
    id,
    kind: "mcp-server",
    manifest: {
      credentialEnv: [],
      description,
      docsUrl: "https://example.test/docs",
      id,
      name,
      schemaVersion: 1,
      serverName,
      supportedApps,
      transportTemplate: { type: "http", url: "https://example.test/mcp" },
    },
    name,
    source: { type: "file", url: `file:///catalog/${serverName}.json` },
    version: "1.0.0",
  };
}

export function answer(id: string, values: readonly string[]): WizardAnswers {
  return { [id]: { kind: "options", values } };
}

export function textAnswers(values: Readonly<Record<string, string>>): WizardAnswers {
  const answers: Record<string, WizardAnswer> = {};
  for (const [id, text] of Object.entries(values)) {
    answers[id] = { kind: "text", text };
  }
  return answers;
}

export function generalAnswers(name: string, appIds: readonly string[]): WizardAnswers {
  return {
    "mcp-apps": { kind: "options", values: appIds },
    "mcp-name": { kind: "text", text: name },
    "mcp-scope": { kind: "options", values: ["global"] },
  };
}
