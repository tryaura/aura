import { describe, expect, it } from "vitest";

import { parseAuraManifest } from "@tryaura/core";
import type { InstructionDocument, Scope, WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import {
  composeConsolidatedInstructions,
  describeInstructionSource,
  instructionInventory,
  instructionTargets,
  type DuplicateCluster,
  type InstructionSource,
} from "./instructions.js";
import type { InstructionScopeSelection } from "./types.js";

describe("instruction inventory", () => {
  it("canonicalizes adapter documents and reports scope, lines, and UTF-8 bytes", () => {
    const global = document("/home/dev/.claude/CLAUDE.md", "global", "é\nnext", "claude");
    const project = document("/repo/project/CURSOR.md", "project", "project\n", "cursor");
    const model = workspaceModel([
      project,
      global,
      { ...global, sourceId: "duplicate-adapter" },
      document("/home/dev/agents/AGENTS.md", "global", "generated\n", "target"),
      document("/repo/project/CLAUDE.md", "project", "wrapper\n", "owned"),
    ]);

    expect(instructionTargets(model)).toEqual({
      global: "/home/dev/agents/AGENTS.md",
      project: "/repo/project/AGENTS.md",
    });
    expect(instructionInventory(model)).toEqual([
      { content: "é\nnext", path: global.path, scope: "global" },
      { content: "project\n", path: project.path, scope: "project" },
    ]);
    expect(describeInstructionSource(source(global.path, "é\nnext"))).toBe("2 lines, 7 bytes");
  });
});

describe("instruction composition", () => {
  it("orders selected sources by path and preserves their exact text", () => {
    const first = source("/home/dev/a.md", "A\r\n");
    const second = source("/home/dev/b.md", "B");
    const ignored = source("/home/dev/c.md", "C\n");

    expect(
      composeConsolidatedInstructions(
        [second, ignored, first],
        selection([second.path, first.path]),
        [],
        workspaceModel([]),
      ),
    ).toBe("# Instructions from ~/a.md\n\nA\r\n\n\n---\n\n# Instructions from ~/b.md\n\nB\n");
  });

  it("names a project source by its repository-relative path, never the checkout", () => {
    const inside: InstructionSource = {
      content: "Project rule\n",
      path: "/repo/project/docs/CLAUDE.md",
      scope: "project",
    };

    const output = composeConsolidatedInstructions(
      [inside],
      { ...selection([inside.path]), scope: "project", targetPath: "/repo/project/AGENTS.md" },
      [],
      workspaceModel([]),
    );

    expect(output).toBe("# Instructions from docs/CLAUDE.md\n\nProject rule\n");
    expect(output).not.toContain("/repo/project");
  });

  it("keeps the selected duplicate winner and removes only the loser range", () => {
    const first = source("/home/dev/a.md", "before\nshared rule\nafter\n");
    const second = source("/home/dev/b.md", "other\nshared rule\nlast\n");
    const cluster: DuplicateCluster = {
      id: "duplicate",
      identical: true,
      members: [
        { endLine: 2, id: `${first.path}:2:2`, path: first.path, startLine: 2 },
        { endLine: 2, id: `${second.path}:2:2`, path: second.path, startLine: 2 },
      ],
      similarity: 100,
    };
    const chosen = selection([first.path, second.path], {
      duplicate: `${second.path}:2:2`,
    });

    const output = composeConsolidatedInstructions(
      [second, first],
      chosen,
      [cluster],
      workspaceModel([]),
    );
    expect(output.match(/shared rule/gu)).toHaveLength(1);
    expect(output).toContain("before\nafter\n");
    expect(output).toContain("other\nshared rule\nlast\n");
  });

  it("drops the section of a source that lost every paragraph, heading and all", () => {
    const shared = "Always run the full verification suite before merging.\n";
    const first = source("/home/dev/a.md", shared);
    const second = source("/home/dev/b.md", shared);
    const cluster: DuplicateCluster = {
      id: "duplicate",
      identical: true,
      members: [
        { endLine: 1, id: `${first.path}:1:1`, path: first.path, startLine: 1 },
        { endLine: 1, id: `${second.path}:1:1`, path: second.path, startLine: 1 },
      ],
      similarity: 100,
    };

    const output = composeConsolidatedInstructions(
      [first, second],
      selection([first.path, second.path], { duplicate: `${first.path}:1:1` }),
      [cluster],
      workspaceModel([]),
    );

    expect(output).toBe(`# Instructions from ~/a.md\n\n${shared}`);
    expect(output).not.toContain("~/b.md");
  });

  it("converges when the originals stay in place and setup runs again", () => {
    const first = source("/home/dev/a.md", "A\n");
    const second = source("/home/dev/b.md", "B\n");
    const chosen = { ...selection([first.path, second.path]), archiveOriginals: false };
    const model = workspaceModel([]);
    const target = "/home/dev/agents/AGENTS.md";

    const once = composeConsolidatedInstructions([first, second], chosen, [], model);
    const twice = composeConsolidatedInstructions([first, second], chosen, [], model, {
      content: once,
      path: target,
      scope: "global",
    });

    expect(twice).toBe(once);
    expect(once.match(/# Instructions from/gu)).toHaveLength(2);
  });

  it("carries an existing target through as the base rather than nesting it", () => {
    const existing: InstructionSource = {
      content: "# Hand written\n\nKeep this.\n",
      path: "/home/dev/agents/AGENTS.md",
      scope: "global",
    };
    const added = source("/home/dev/a.md", "A\n");

    const output = composeConsolidatedInstructions(
      [added],
      selection([added.path]),
      [],
      workspaceModel([]),
      existing,
    );

    expect(output).toBe(
      "# Hand written\n\nKeep this.\n\n\n---\n\n# Instructions from ~/a.md\n\nA\n",
    );
    expect(output).not.toContain(`# Instructions from ${existing.path}`);
  });
});

function document(
  path: string,
  scope: Scope,
  content: string,
  sourceId: string,
): InstructionDocument {
  return { content, links: [], path, scope, sourceId };
}

function source(path: string, content: string): InstructionSource {
  return { content, path, scope: "global" };
}

function selection(
  selectedSources: readonly string[],
  duplicateWinners: Readonly<Record<string, string>> = {},
): InstructionScopeSelection {
  return {
    action: "consolidate",
    archiveOriginals: true,
    duplicateWinners,
    scope: "global",
    selectedSources,
    targetPath: "/home/dev/agents/AGENTS.md",
  };
}

function workspaceModel(instructionFiles: readonly InstructionDocument[]): WorkspaceModel {
  const manifest = parseAuraManifest(
    JSON.stringify({
      apps: {},
      mcpServers: [],
      ownership: { fixture: { files: ["/repo/project/CLAUDE.md"], mcpServerNames: [] } },
      schemaVersion: 1,
      skills: [],
      snippets: [],
    }),
    "/home/dev/agents/aura.json",
  );
  return createWorkspaceModel({
    cwd: "/repo/fallback",
    instructionFiles,
    manifest,
    projectRoot: "/repo/project",
    sharedInstructions: {
      content: "generated\n",
      exists: true,
      path: "/home/dev/agents/AGENTS.md",
    },
  });
}
