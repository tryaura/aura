import type { AdapterFileKind, AdapterSourceFile, Scope } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { codexAdapter } from "./adapter.js";

describe("Codex project scope", () => {
  it("parses the global and project AGENTS.md in scope order", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "codex.instructions.global",
          source(
            "codex.instructions.global",
            "/home/dev/.codex/AGENTS.md",
            "instructions",
            "global",
            "# Global\n",
          ),
        ],
        [
          "codex.instructions.project",
          source(
            "codex.instructions.project",
            "/workspace/AGENTS.md",
            "instructions",
            "project",
            "# Project\n",
          ),
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles).toEqual([
      {
        content: "# Global\n",
        links: [],
        path: "/home/dev/.codex/AGENTS.md",
        scope: "global",
        sourceId: "codex.instructions.global",
      },
      {
        content: "# Project\n",
        links: [],
        path: "/workspace/AGENTS.md",
        scope: "project",
        sourceId: "codex.instructions.project",
      },
    ]);
  });

  it("models a symlinked project AGENTS.md as a link for INS-002 to judge", () => {
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([
        [
          "codex.instructions.project",
          {
            ...source(
              "codex.instructions.project",
              "/workspace/AGENTS.md",
              "instructions",
              "project",
              "# Shared\n",
            ),
            pathKind: "symlink",
            symlinkTarget: "/home/dev/agents/AGENTS.md",
          },
        ],
      ]),
      homeDir: "/home/dev",
    });

    expect(snapshot.instructionFiles).toEqual([
      {
        content: "# Shared\n",
        links: [{ kind: "symlink", targetPath: "/home/dev/agents/AGENTS.md", valid: false }],
        path: "/workspace/AGENTS.md",
        scope: "project",
        sourceId: "codex.instructions.project",
      },
    ]);
  });

  it("claims nothing about a project path core refused to read, or one that is absent", () => {
    const refused: AdapterSourceFile = {
      exists: true,
      problem: "outside-project",
      spec: {
        id: "codex.instructions.project",
        kind: "instructions",
        path: "/workspace/AGENTS.md",
        scope: "project",
      },
    };

    expect(
      codexAdapter.parse({
        cwd: "/workspace",
        detection: { installed: true },
        files: new Map([[refused.spec.id, refused]]),
        homeDir: "/home/dev",
      }).instructionFiles,
    ).toEqual([]);
    expect(
      codexAdapter.parse({
        cwd: "/workspace",
        detection: { installed: true },
        files: new Map(),
        homeDir: "/home/dev",
      }).instructionFiles,
    ).toEqual([]);
  });

  it("keeps MCP servers when the projects table is malformed", () => {
    const config = source(
      "codex.mcp.global",
      "/home/dev/.codex/config.toml",
      "mcp",
      "global",
      ['projects = "nope"', "", "[mcp_servers.docs]", 'command = "npx"', ""].join("\n"),
    );
    const snapshot = codexAdapter.parse({
      cwd: "/workspace",
      detection: { installed: true },
      files: new Map([[config.spec.id, config]]),
      homeDir: "/home/dev",
      projectRoot: "/workspace",
    });

    expect(snapshot.mcpServers.map((server) => server.name)).toEqual(["docs"]);
    expect(snapshot.metadata).toEqual({ projectTrust: "unknown" });
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
