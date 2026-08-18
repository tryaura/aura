import {
  collectJsonMcpServers,
  EMPTY_COLLECTION,
  isConfigRecord,
  jsonMcpSecretTransform,
  jsonMcpEntry,
  parseJsonMcpConfig,
  parseConfigObject,
  writeJsonMcpServers,
  type AdapterSourceFile,
  type JsonMcpConfigOptions,
  type McpEntryCollection,
  type McpSecretSighting,
  type McpWrite,
  type OwnedServerEntry,
  type ParsedJsonMcpConfig,
  type UnusableMcpServer,
} from "@tryaura/aura-sdk";

import { CLAUDE_CODE_ADAPTER_ID } from "./contract.js";

const OPTIONS: JsonMcpConfigOptions = {
  appId: CLAUDE_CODE_ADAPTER_ID,
  variablePattern: /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?\}/gu,
};

/** What one Claude Code configuration file contributed. */
export type ClaudeMcpConfig = ParsedJsonMcpConfig;

/** What `~/.claude.json` contributed, split by the two records it keeps servers in. */
export interface ClaudeGlobalMcpConfig {
  /** Servers at the top of the document, which apply wherever Claude Code runs. */
  readonly globalServers: McpEntryCollection["servers"];
  /** See {@link ParsedJsonMcpConfig.malformed}. */
  readonly malformed: boolean;
  /** Value-free inline credential locations from both records. */
  readonly secretSightings?: readonly McpSecretSighting[] | undefined;
  /** Servers `projects` configures for the invocation directory alone. */
  readonly localServers: McpEntryCollection["servers"];
  /** Entries from either record that Aura recognized by name but could not model. */
  readonly unusable: readonly UnusableMcpServer[];
}

/** Parses a file whose servers sit at the top level, as a project `.mcp.json` does. */
export function parseMcpServers(file: AdapterSourceFile): ClaudeMcpConfig {
  return parseJsonMcpConfig(file, OPTIONS);
}

/** Serializes one canonical Claude Code MCP target without touching unrelated JSON entries. */
export const writeMcpServers: McpWrite = (input) => writeJsonMcpServers(input, writeEntry);

/**
 * Parses `~/.claude.json`, which holds the global servers and the local-scope ones together.
 *
 * `claude mcp add -s local` files a server under `projects`, keyed by the exact directory Claude
 * Code was launched from. That key is matched exactly: the repository root is a different
 * directory, and a realpath alias is a path Claude Code would not itself have written, so guessing
 * either would attribute servers to a workspace that does not have them.
 *
 * Both records come out of one parse. This is the largest file a scan reads — it grows with every
 * project the user has opened — and reaching the two through separate entry points parsed it twice.
 */
export function parseGlobalMcpServers(file: AdapterSourceFile, cwd: string): ClaudeGlobalMcpConfig {
  const root = parseConfigObject(file.content, parseJson);
  if (root === undefined) {
    return {
      globalServers: [],
      localServers: [],
      malformed: file.content !== undefined,
      unusable: [],
    };
  }

  const global = collectJsonMcpServers(file, root["mcpServers"], OPTIONS);
  const local = localServers(file, root, cwd);
  return {
    globalServers: global.servers,
    localServers: local.servers,
    malformed: false,
    secretSightings: [...(global.secretSightings ?? []), ...(local.secretSightings ?? [])],
    unusable: [...global.unusable, ...local.unusable],
  };
}

/**
 * The servers configured for one directory, filed as project scope against `~/.claude.json`.
 *
 * `sourceId` stays the global spec's, because {@link McpServer.sourceId} names a spec the adapter
 * declared and `~/.claude.json` is both the file these came from and the file a user has to edit
 * to change them. Scope is what separates them from the servers at the top of the same document.
 */
function localServers(
  file: AdapterSourceFile,
  root: Readonly<Record<string, unknown>>,
  cwd: string,
): McpEntryCollection {
  const projects = root["projects"];
  if (!isConfigRecord(projects)) {
    return EMPTY_COLLECTION;
  }

  const project = projects[cwd];
  if (!isConfigRecord(project)) {
    return EMPTY_COLLECTION;
  }

  const projectFile: AdapterSourceFile = { ...file, spec: { ...file.spec, scope: "project" } };
  return collectJsonMcpServers(projectFile, project["mcpServers"], {
    ...OPTIONS,
    recordPath: ["projects", cwd, "mcpServers"],
  });
}

/** Claude Code expands `${VAR}` references throughout MCP entries. */
export const transformMcpSecrets = jsonMcpSecretTransform(
  (name) => `\${${name}}`,
  OPTIONS.variablePattern,
);

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function writeEntry(entry: OwnedServerEntry): Readonly<Record<string, unknown>> {
  return jsonMcpEntry(entry, (name) => `\${${name}}`);
}
