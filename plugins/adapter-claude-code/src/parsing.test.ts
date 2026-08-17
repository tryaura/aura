import { describe, expect, it } from "vitest";

import { claudeCodeAdapter } from "./adapter.js";
import { readClaudePermissionMode } from "./contract.js";

describe("Claude Code parsing", () => {
  it("records global and project permission summaries without permission entries", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.settings.global",
          {
            content: JSON.stringify({
              permissions: {
                allow: ["Bash(secret-command)", "Read"],
                defaultMode: "dontAsk",
                deny: ["WebFetch"],
              },
            }),
            exists: true,
            spec: {
              id: "claude-code.settings.global",
              kind: "config",
              path: "/home/dev/.claude/settings.json",
              scope: "global",
            },
          },
        ],
        [
          "claude-code.settings.project",
          {
            content: JSON.stringify({
              permissions: { allow: ["Edit"], defaultMode: "plan", deny: [] },
            }),
            exists: true,
            spec: {
              id: "claude-code.settings.project",
              kind: "config",
              path: "/workspace/.claude/settings.json",
              scope: "project",
            },
          },
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.metadata).toEqual({
      claudePermissions: {
        global: { allowCount: 2, defaultMode: "dontAsk", denyCount: 1 },
        project: { allowCount: 1, defaultMode: "plan", denyCount: 0 },
      },
    });
    expect(JSON.stringify(snapshot.metadata)).not.toContain("secret-command");
  });

  it("records local settings and resolves them as the highest-precedence permission mode", () => {
    const settingsFile = (id: string, path: string, defaultMode: string) =>
      [
        id,
        {
          content: JSON.stringify({ permissions: { defaultMode } }),
          exists: true,
          spec: { id, kind: "config", path, scope: "project" },
        },
      ] as const;
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        settingsFile(
          "claude-code.settings.local",
          "/workspace/.claude/settings.local.json",
          "bypassPermissions",
        ),
        settingsFile("claude-code.settings.project", "/workspace/.claude/settings.json", "plan"),
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.metadata).toEqual({
      claudePermissions: {
        local: { defaultMode: "bypassPermissions" },
        project: { defaultMode: "plan" },
      },
    });
    expect(
      readClaudePermissionMode({
        adapterId: "claude-code",
        detection: { installed: true },
        displayName: "Claude Code",
        instructionFiles: [],
        mcpServers: [],
        metadata: snapshot.metadata,
        skills: [],
        sourceFiles: [],
        support: { status: "supported", supportedRange: ">=2.1.0 <3.0.0" },
      }),
    ).toEqual({ mode: "bypassPermissions", sourceId: "claude-code.settings.local" });
  });

  it("drops malformed settings metadata while preserving MCP results", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.mcp.global",
          {
            content: JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }),
            exists: true,
            spec: {
              id: "claude-code.mcp.global",
              kind: "mcp",
              path: "/home/dev/.claude.json",
              scope: "global",
            },
          },
        ],
        [
          "claude-code.settings.global",
          {
            content: '{"permissions":{"defaultMode":"plan","allow":["secret"]}',
            exists: true,
            spec: {
              id: "claude-code.settings.global",
              kind: "config",
              path: "/home/dev/.claude/settings.json",
              scope: "global",
            },
          },
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.metadata).toBeUndefined();
    expect(snapshot.mcpServers.map((server) => server.name)).toEqual(["docs"]);
  });

  it("resolves home-relative imports against the home directory the spec was built from", () => {
    const snapshot = claudeCodeAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "claude-code.instructions.global",
          {
            content: "@~/agents/AGENTS.md\n",
            exists: true,
            spec: {
              id: "claude-code.instructions.global",
              kind: "instructions",
              path: "/home/dev/.claude/CLAUDE.md",
              scope: "global",
            },
          },
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles[0]?.links).toEqual([
      { kind: "import", targetPath: "/home/dev/agents/AGENTS.md", valid: false },
    ]);
  });
});
