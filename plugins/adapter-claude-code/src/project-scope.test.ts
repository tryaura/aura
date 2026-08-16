import type { AdapterFileKind, AdapterSourceFile, Scope } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "./adapter.js";

describe("Claude Code project scope", () => {
  it("parses project instructions and every MCP scope in specificity order", () => {
    const globalMcp = source(
      "claude-code.mcp.global",
      "/home/dev/.claude.json",
      "mcp",
      "global",
      JSON.stringify({
        mcpServers: { global: { command: "global-server" } },
        projects: {
          "/other": { mcpServers: { ignored: { command: "ignored-server" } } },
          "/workspace": { mcpServers: { local: { command: "local-server" } } },
        },
      }),
    );
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.instructions.global",
          source(
            "claude-code.instructions.global",
            "/home/dev/.claude/CLAUDE.md",
            "instructions",
            "global",
            "@~/agents/AGENTS.md\n",
          ),
        ],
        [
          "claude-code.instructions.project",
          source(
            "claude-code.instructions.project",
            "/workspace/CLAUDE.md",
            "instructions",
            "project",
            "@./docs/project.md\n@~/agents/AGENTS.md\n",
          ),
        ],
        ["claude-code.mcp.global", globalMcp],
        [
          "claude-code.mcp.project",
          source(
            "claude-code.mcp.project",
            "/workspace/.mcp.json",
            "mcp",
            "project",
            JSON.stringify({ mcpServers: { project: { command: "project-server" } } }),
          ),
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles).toMatchObject([
      { path: "/home/dev/.claude/CLAUDE.md", scope: "global" },
      {
        links: [
          { targetPath: "/workspace/docs/project.md" },
          { targetPath: "/home/dev/agents/AGENTS.md" },
        ],
        path: "/workspace/CLAUDE.md",
        scope: "project",
        sourceId: "claude-code.instructions.project",
      },
    ]);
    expect(
      snapshot.mcpServers.map((server) => [server.name, server.scope, server.sourceId]),
    ).toEqual([
      ["global", "global", "claude-code.mcp.global"],
      ["project", "project", "claude-code.mcp.project"],
      ["local", "project", "claude-code.mcp.global"],
    ]);
    expect(snapshot.problems).toEqual([]);
  });

  it("reports each unusable MCP file against the spec that declared it", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.mcp.global",
          source("claude-code.mcp.global", "/home/dev/.claude.json", "mcp", "global", "{"),
        ],
        [
          "claude-code.mcp.project",
          source("claude-code.mcp.project", "/workspace/.mcp.json", "mcp", "project", "nope"),
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.mcpServers).toEqual([]);
    expect(snapshot.problems).toEqual([
      {
        message:
          "Claude Code's MCP configuration at /home/dev/.claude.json is not a valid JSON object, so none of the servers it declares are loading — in Claude Code either. Fix the file to restore them.",
        sourceId: "claude-code.mcp.global",
      },
      {
        message:
          "Claude Code's MCP configuration at /workspace/.mcp.json is not a valid JSON object, so none of the servers it declares are loading — in Claude Code either. Fix the file to restore them.",
        sourceId: "claude-code.mcp.project",
      },
    ]);
  });

  it("reports nothing for MCP files that are simply absent", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map(),
      homeDir: "/home/dev",
    });

    expect(snapshot.problems).toEqual([]);
  });
});

function source(
  id: string,
  path: string,
  kind: AdapterFileKind,
  scope: Scope,
  content: string,
): AdapterSourceFile {
  return { content, exists: true, spec: { id, kind, path, scope } };
}
