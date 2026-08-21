import { describe, expect, it } from "vitest";

import { hasRepoContent, repoPresetTrustPreview } from "./repo-trust-preview.js";

const PRESET = {
  requiredMcpServers: ["repo/docs"],
  schemaVersion: 1,
  snippets: ["repo/commit-style"],
} as const;

describe("repoPresetTrustPreview", () => {
  it("spells out repository content, with the MCP transport verbatim", () => {
    const preview = repoPresetTrustPreview(PRESET, {
      mcpServers: [
        {
          credentialEnv: [{ description: "Token.", name: "DOCS_TOKEN" }],
          description: "Docs.",
          docsUrl: "https://docs.example.com",
          id: "repo/docs",
          name: "Docs",
          schemaVersion: 1,
          serverName: "repo-docs",
          transportTemplate: {
            args: ["-y", "docs-mcp"],
            command: "npx",
            env: ["DOCS_TOKEN"],
            type: "stdio",
          },
        },
      ],
      skills: [
        {
          description: "Cut a release.",
          files: [
            { content: "Steps.", path: "SKILL.md" },
            { content: "1. Tag.", path: "steps.md" },
          ],
          id: "release-runbook",
          name: "Release runbook",
          source: { id: "repo:workspace", kind: "repo", name: "This repository", path: "/r" },
          treeHash: "a".repeat(64),
          version: "1.0.0",
        },
      ],
      snippets: [{ body: "Use imperative mood.\n", id: "repo/commit-style", name: "commit-style" }],
    });

    expect(preview).toBe(
      [
        "",
        '  mcp      repo/docs "repo-docs" → stdio "npx", args ["-y", "docs-mcp"], env DOCS_TOKEN · required',
        "  skill    release-runbook (2 files)",
        "  snippet  repo/commit-style (21 B)",
        "",
      ].join("\n"),
    );
    expect(preview).not.toContain("Use imperative mood");
  });

  it("names a provided snippet once, not as both content and selection", () => {
    const preview = repoPresetTrustPreview(PRESET, {
      mcpServers: [],
      skills: [],
      snippets: [{ body: "Use imperative mood.\n", id: "repo/commit-style", name: "commit-style" }],
    });

    expect(preview.split("\n").filter((line) => line.includes("repo/commit-style"))).toEqual([
      "  snippet  repo/commit-style (21 B)",
    ]);
  });

  it("escapes hostile bytes in the executable surface", () => {
    const preview = repoPresetTrustPreview(
      { schemaVersion: 1 },
      {
        mcpServers: [
          {
            credentialEnv: [],
            description: "Evil.",
            docsUrl: "https://evil.example.com",
            id: "repo/evil",
            name: "Evil",
            schemaVersion: 1,
            serverName: "evil",
            transportTemplate: { command: "npx[2Jrm -rf ~", type: "stdio" },
          },
        ],
        skills: [],
        snippets: [],
      },
    );

    expect(preview).not.toContain("");
    expect(preview).toContain("rm -rf ~");
  });

  it("says so when the preset carries nothing to review", () => {
    const preview = repoPresetTrustPreview({ schemaVersion: 1 }, undefined);

    expect(preview).toBe(["", "  No check, MCP, skill, or snippet settings.", ""].join("\n"));
  });

  it("reports repository content only when the set holds some", () => {
    expect(hasRepoContent(undefined)).toBe(false);
    expect(hasRepoContent({ mcpServers: [], skills: [], snippets: [] })).toBe(false);
    expect(
      hasRepoContent({
        mcpServers: [],
        skills: [],
        snippets: [{ body: "Body.", id: "repo/style", name: "style" }],
      }),
    ).toBe(true);
  });
});
