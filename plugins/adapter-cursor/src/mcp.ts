import { parseJsonMcpServers, type AdapterSourceFile, type McpServer } from "@tryaura/aura-sdk";

const VARIABLE_PATTERN = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu;

export function parseMcpServers(file: AdapterSourceFile): readonly McpServer[] {
  return parseJsonMcpServers(file, { appId: "cursor", variablePattern: VARIABLE_PATTERN });
}
