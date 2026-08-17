import {
  collectJsonMcpServers,
  parseConfigObject,
  type AdapterSourceFile,
  type JsonMcpConfigOptions,
  type McpServer,
} from "@tryaura/aura-sdk";

import { CURSOR_ADAPTER_ID } from "./contract.js";

const OPTIONS: JsonMcpConfigOptions = {
  appId: CURSOR_ADAPTER_ID,
  variablePattern: /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu,
};

/** What one Cursor MCP configuration file contributed. */
export interface CursorMcpConfig {
  /**
   * Whether the file held something other than a JSON object.
   *
   * Kept apart from an empty server list because the two need opposite advice: one user has no MCP
   * servers, the other has servers that are silently not loading.
   */
  readonly malformed: boolean;
  readonly servers: readonly McpServer[];
}

export function parseMcpServers(file: AdapterSourceFile): CursorMcpConfig {
  const root = parseConfigObject(file.content, (text): unknown => JSON.parse(text));
  if (root === undefined) {
    return { malformed: file.content !== undefined, servers: [] };
  }

  return { malformed: false, servers: collectJsonMcpServers(file, root["mcpServers"], OPTIONS) };
}
