import {
  jsonMcpEntry,
  parseJsonMcpConfig,
  writeJsonMcpServers,
  type AdapterSourceFile,
  type JsonMcpConfigOptions,
  type McpWrite,
  type OwnedServerEntry,
  type ParsedJsonMcpConfig,
} from "@tryaura/aura-sdk";

import { CURSOR_ADAPTER_ID } from "./contract.js";

const OPTIONS: JsonMcpConfigOptions = {
  appId: CURSOR_ADAPTER_ID,
  variablePattern: /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu,
};

/** What one Cursor MCP configuration file contributed. */
export type CursorMcpConfig = ParsedJsonMcpConfig;

export function parseMcpServers(file: AdapterSourceFile): CursorMcpConfig {
  return parseJsonMcpConfig(file, OPTIONS);
}

/** Serializes one canonical Cursor MCP target using Cursor's environment-reference spelling. */
export const writeMcpServers: McpWrite = (input) => writeJsonMcpServers(input, writeEntry);

function writeEntry(entry: OwnedServerEntry): Readonly<Record<string, unknown>> {
  return jsonMcpEntry(entry, (name) => `\${env:${name}}`);
}
