import type { AdapterSourceFile } from "@tryaura/aura-sdk";

/** One `~/.claude.json`-shaped source file, so both MCP suites read the same declaration. */
export function mcpFile(content: string): AdapterSourceFile {
  return {
    content,
    exists: true,
    spec: {
      id: "claude-code.mcp.global",
      kind: "mcp",
      path: "/home/dev/.claude.json",
      scope: "global",
    },
  };
}
