import { describe, expect, it } from "vitest";

import { parseAuraManifest } from "@tryaura/core";
import type {
  AppModel,
  InstructionDocument,
  ResolvedSharedLink,
  Scope,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";

import { instructionInventory } from "./instructions.js";

const TARGET = "/home/dev/agents/AGENTS.md";
const PLAIN_IMPORT = "@~/agents/AGENTS.md\n";

const MANAGED_BLOCK = [
  "<!-- aura:begin -->",
  "Managed by Aura. Edit via the Aura CLI; manual edits to this block are overwritten.",
  `<!-- aura:begin id=shared-instructions sha256=${"0".repeat(64)} -->`,
  "@~/agents/AGENTS.md",
  "<!-- aura:end id=shared-instructions -->",
  "<!-- aura:end -->",
  "",
].join("\n");

describe("instruction inventory and Aura's own artifacts", () => {
  it("excludes a symlink alias of the consolidation target", () => {
    const alias = {
      ...document("/home/dev/.codex/AGENTS.md", "global", "generated\n"),
      canonicalPath: TARGET,
    };

    expect(instructionInventory(model([alias]))).toEqual([]);
  });

  it("excludes a canonical alias of a manifest-owned file", () => {
    const alias = {
      ...document("/home/dev/link.md", "global", "wrapper\n"),
      canonicalPath: "/repo/project/CLAUDE.md",
    };

    expect(instructionInventory(model([alias]))).toEqual([]);
  });

  it("collapses two names for one physical file into a single offer", () => {
    const short = document("/home/dev/.claude/CLAUDE.md", "global", "short\n");
    const long = document("/home/dev/dotfiles/CLAUDE.md", "global", "longer content\n");
    const canonical = "/home/dev/dotfiles/CLAUDE.md";

    const offered = instructionInventory(
      model([
        { ...short, canonicalPath: canonical },
        { ...long, canonicalPath: canonical },
      ]),
    );

    expect(offered).toHaveLength(1);
    expect(offered[0]?.content).toBe("longer content\n");
  });

  it("excludes an import-line entry that is exactly Aura's legacy managed block", () => {
    const entry = document("/home/dev/.claude/CLAUDE.md", "global", MANAGED_BLOCK);

    expect(instructionInventory(model([entry], [app("claude-code", importLink())]))).toEqual([]);
  });

  it("excludes an exact plain import but still offers user text before its suffix", () => {
    const exact = document("/home/dev/.claude/CLAUDE.md", "global", PLAIN_IMPORT);
    const withUserText = document(
      "/home/dev/.claude/CLAUDE.md",
      "global",
      `# Mine\n\nKeep this.\n\n${PLAIN_IMPORT}`,
    );
    const application = app("claude-code", importLink());

    expect(instructionInventory(model([exact], [application]))).toEqual([]);
    expect(instructionInventory(model([withUserText], [application]))).toEqual([
      { content: withUserText.content, path: withUserText.path, scope: "global" },
    ]);
  });

  it("still offers an import-line entry that carries user text beyond the block", () => {
    const content = `# Mine\n\nKeep this.\n${MANAGED_BLOCK}`;
    const entry = document("/home/dev/.claude/CLAUDE.md", "global", content);

    const offered = instructionInventory(model([entry], [app("claude-code", importLink())]));

    expect(offered).toEqual([{ content, path: entry.path, scope: "global" }]);
  });

  it("treats legacy project copies as user-owned instruction sources", () => {
    const link: ResolvedSharedLink = {
      content: "Follow the shared instructions.\n",
      entryPath: "/repo/project/.cursor/rules/aura.mdc",
      kind: "native-copy",
      scope: "project",
    };
    const pristine = document(link.entryPath, "project", link.content ?? "");
    const edited = document(link.entryPath, "project", "Hand-edited rule.\n");

    expect(instructionInventory(model([pristine]))).toEqual([
      { content: link.content, path: link.entryPath, scope: "project" },
    ]);
    expect(instructionInventory(model([edited]))).toEqual([
      { content: "Hand-edited rule.\n", path: link.entryPath, scope: "project" },
    ]);
  });
});

function importLink(): ResolvedSharedLink {
  return {
    content: PLAIN_IMPORT,
    entryPath: "/home/dev/.claude/CLAUDE.md",
    kind: "import-line",
    scope: "global",
  };
}

function app(id: string, sharedLink: ResolvedSharedLink): AppModel {
  return {
    adapterId: id,
    detection: { installed: true },
    displayName: id,
    instructionFiles: [],
    mcpServers: [],
    metadata: undefined,
    skills: [],
    sourceFiles: [],
    support: { status: "supported", supportedRange: ">=1 <2" },
    sharedLink,
  };
}

function document(path: string, scope: Scope, content: string): InstructionDocument {
  return { content, links: [], path, scope, sourceId: "fixture" };
}

function model(
  instructionFiles: readonly InstructionDocument[],
  apps: readonly AppModel[] = [],
): WorkspaceModel {
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
    apps,
    cwd: "/repo/fallback",
    instructionFiles,
    manifest,
    projectRoot: "/repo/project",
    sharedInstructions: { content: "generated\n", exists: true, path: TARGET },
  });
}
