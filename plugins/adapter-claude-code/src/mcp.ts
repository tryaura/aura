import {
  collectJsonMcpServers,
  isConfigRecord,
  parseConfigObject,
  type AdapterSourceFile,
  type JsonMcpConfigOptions,
  type McpServer,
} from "@tryaura/aura-sdk";

import { CLAUDE_CODE_ADAPTER_ID } from "./contract.js";

const OPTIONS: JsonMcpConfigOptions = {
  appId: CLAUDE_CODE_ADAPTER_ID,
  variablePattern: /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?\}/gu,
};

/** What one Claude Code configuration file contributed. */
export interface ClaudeMcpConfig {
  /**
   * Whether the file held something other than a JSON object.
   *
   * Kept apart from an empty server list because the two need opposite advice: one user has no MCP
   * servers, the other has servers that are silently not loading.
   */
  readonly malformed: boolean;
  readonly servers: readonly McpServer[];
}

/** What `~/.claude.json` contributed, split by the two records it keeps servers in. */
export interface ClaudeGlobalMcpConfig {
  /** Servers at the top of the document, which apply wherever Claude Code runs. */
  readonly globalServers: readonly McpServer[];
  /** See {@link ClaudeMcpConfig.malformed}. */
  readonly malformed: boolean;
  /** Servers `projects` configures for the invocation directory alone. */
  readonly localServers: readonly McpServer[];
}

/** Parses a file whose servers sit at the top level, as a project `.mcp.json` does. */
export function parseMcpServers(file: AdapterSourceFile): ClaudeMcpConfig {
  const root = parseConfigObject(file.content, parseJson);
  if (root === undefined) {
    return { malformed: file.content !== undefined, servers: [] };
  }

  return { malformed: false, servers: collectJsonMcpServers(file, root["mcpServers"], OPTIONS) };
}

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
    return { globalServers: [], localServers: [], malformed: file.content !== undefined };
  }

  return {
    globalServers: collectJsonMcpServers(file, root["mcpServers"], OPTIONS),
    localServers: localServers(file, root, cwd),
    malformed: false,
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
): readonly McpServer[] {
  const projects = root["projects"];
  if (!isConfigRecord(projects)) {
    return [];
  }

  const project = projects[cwd];
  if (!isConfigRecord(project)) {
    return [];
  }

  const projectFile: AdapterSourceFile = { ...file, spec: { ...file.spec, scope: "project" } };
  return collectJsonMcpServers(projectFile, project["mcpServers"], OPTIONS);
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}
