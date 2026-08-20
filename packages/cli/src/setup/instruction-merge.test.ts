import { describe, expect, it } from "vitest";

import { parseAuraManifest } from "@tryaura/core";
import type { WorkspaceModel } from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import { composeConsolidatedInstructions, unmergedSources } from "./instruction-merge.js";
import type { InstructionSource } from "./instructions.js";
import type { InstructionScopeSelection } from "./types.js";

const MANAGED_BLOCK = [
  "<!-- aura:begin -->",
  "Managed by Aura. Edit via the Aura CLI; manual edits to this block are overwritten.",
  `<!-- aura:begin id=shared-instructions sha256=${"0".repeat(64)} -->`,
  "@~/agents/AGENTS.md",
  "<!-- aura:end id=shared-instructions -->",
  "<!-- aura:end -->",
  "",
].join("\n");

describe("managed blocks in consolidation", () => {
  it("merges only the user text of a source that carries Aura's block", () => {
    const wired: InstructionSource = {
      content: `# Mine\n\nKeep this.\n${MANAGED_BLOCK}`,
      path: "/home/dev/.claude/CLAUDE.md",
      scope: "global",
    };

    const output = composeConsolidatedInstructions([wired], selection([wired.path]), [], model());

    expect(output).toContain("Keep this.");
    expect(output).not.toContain("aura:begin");
    expect(output).not.toContain("@~/agents/AGENTS.md");
  });

  it("takes no section from a source that is exactly the block", () => {
    const bare: InstructionSource = {
      content: MANAGED_BLOCK,
      path: "/home/dev/.claude/CLAUDE.md",
      scope: "global",
    };

    const output = composeConsolidatedInstructions([bare], selection([bare.path]), [], model());

    expect(output).toBe("\n");
    expect(output).not.toContain("# Instructions from");
  });

  it("agrees with unmergedSources on the stripped text, so archiving stays safe", () => {
    const wired: InstructionSource = {
      content: `User rule.\n${MANAGED_BLOCK}`,
      path: "/home/dev/.claude/CLAUDE.md",
      scope: "global",
    };
    const chosen = selection([wired.path]);
    const merged = composeConsolidatedInstructions([wired], chosen, [], model());
    const target: InstructionSource = {
      content: merged,
      path: "/home/dev/agents/AGENTS.md",
      scope: "global",
    };

    // The target holds everything the merge would take, block and all excluded, so the source is
    // safe to archive; an edit after the merge is still reported.
    expect(unmergedSources([wired], chosen, [], model(), target)).toEqual([]);
    const edited: InstructionSource = {
      ...wired,
      content: `User rule.\n\nAdded later.\n${MANAGED_BLOCK}`,
    };
    expect(unmergedSources([edited], chosen, [], model(), target)).toEqual([wired.path]);
  });
});

describe("sources that lose every paragraph to a duplicate", () => {
  const BODY = "# Global Preferences\n\n## Workflow\n\n- Be brief.\n";
  const winner: InstructionSource = {
    content: BODY,
    path: "/home/dev/.claude/CLAUDE.md",
    scope: "global",
  };
  // Byte-identical to the winner, the way a hand-synced pair of global instruction files is.
  const loser: InstructionSource = { ...winner, path: "/home/dev/.codex/AGENTS.md" };
  const sources = [winner, loser];
  // INS-003 claims the bullet, which is all either file says; neither file's headings are in it.
  const clusters = [
    {
      id: "cluster-1",
      identical: true,
      members: [
        { endLine: 5, id: "winner", path: winner.path, startLine: 5 },
        { endLine: 5, id: "loser", path: loser.path, startLine: 5 },
      ],
      similarity: 1,
    },
  ];
  const chosen: InstructionScopeSelection = {
    ...selection([winner.path, loser.path]),
    duplicateWinners: { "cluster-1": "winner" },
  };

  it("writes no provenance heading for the skeleton the winner left behind", () => {
    const output = composeConsolidatedInstructions(sources, chosen, clusters, model());

    expect(output).toContain("- Be brief.");
    // The headings survive `removeRanges` untouched, so a bare non-blank test would emit them twice.
    expect(output.match(/## Workflow/gu)).toHaveLength(1);
    expect(output).not.toContain(".codex/AGENTS.md");
  });

  it("still calls the emptied source safe to archive", () => {
    const target: InstructionSource = {
      content: composeConsolidatedInstructions(sources, chosen, clusters, model()),
      path: "/home/dev/agents/AGENTS.md",
      scope: "global",
    };

    expect(unmergedSources(sources, chosen, clusters, model(), target)).toEqual([]);
  });
});

function selection(selectedSources: readonly string[]): InstructionScopeSelection {
  return {
    action: "consolidate",
    duplicateWinners: {},
    scope: "global",
    selectedSources,
    targetPath: "/home/dev/agents/AGENTS.md",
  };
}

function model(): WorkspaceModel {
  const manifest = parseAuraManifest(
    JSON.stringify({
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [],
    }),
    "/home/dev/agents/aura.json",
  );
  return createWorkspaceModel({
    cwd: "/repo/fallback",
    manifest,
    projectRoot: "/repo/project",
    sharedInstructions: {
      content: "generated\n",
      exists: true,
      path: "/home/dev/agents/AGENTS.md",
    },
  });
}
