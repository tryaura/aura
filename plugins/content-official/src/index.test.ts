import { readFile } from "node:fs/promises";

import {
  buildWorkspaceModel,
  createEnvironment,
  createPluginRegistry,
  hashManagedSnippet,
} from "@tryaura/core";
import type { Snippet } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import officialContent from "./index.js";

const EXPECTED_SNIPPETS = [
  ["official/commit-conventions", "git", "Commit conventions"],
  ["official/ask-before-destructive", "safety", "Ask before destructive operations"],
  ["official/pr-descriptions", "git", "Pull request descriptions"],
  ["official/jira-linking", "atlassian", "Jira issue linking"],
  ["official/confluence-references", "atlassian", "Confluence references"],
  ["official/typescript-style", "language", "TypeScript style"],
  ["official/python-style", "language", "Python style"],
] as const;

// Deliberate allowlist: extend it when a new snippet instruction starts with an unlisted verb.
const IMPERATIVE_PREFIX =
  /^(?:Add|Ask|Avoid|Call|Choose|Confirm|Declare|Enable|Explain|Fix|Include|Introduce|Keep|Link|List|Mark|Model|Name|Never|Omit|Prefer|Preserve|Run|Stop|Structure|Summarize|Update|Use|Write)\b/u;

describe("official snippets", () => {
  it("registers the complete starter set through the plugin registry", () => {
    const registry = createPluginRegistry([officialContent]);

    expect(
      registry.snippets.map((snippet) => [snippet.id, snippet.category, snippet.name]),
    ).toEqual(EXPECTED_SNIPPETS);
  });

  it("registers AgenticSkills through its provider adapter", () => {
    const registry = createPluginRegistry([officialContent]);

    expect(registry.skillDirectories).toEqual([
      {
        id: "directory:agenticskills",
        kind: "directory",
        name: "agenticskills.io",
        protocol: "agenticskills",
        url: "https://agenticskills.io",
      },
    ]);
  });

  it("keeps every source portable, concise, and suitable for picker previews", async () => {
    for (const snippet of officialContent.snippets) {
      const content = await readSnippet(snippet);
      const lines = content.trimEnd().split(/\r?\n/u);
      const instructions = lines.filter((line) => line.startsWith("- "));

      expect(content.length, snippet.id).toBeGreaterThan(0);
      expect(lines.length, snippet.id).toBeLessThanOrEqual(40);
      expect(content, snippet.id).not.toMatch(/^---(?:\r?\n|$)/u);
      expect(content, snippet.id).not.toMatch(/^\s*@(?:import|include)\b/mu);
      expect(content, snippet.id).not.toMatch(/\b(?:the agent|agents?) should\b/iu);
      expect(instructions.length, snippet.id).toBeGreaterThan(0);
      for (const instruction of instructions) {
        expect(instruction.slice(2), snippet.id).toMatch(IMPERATIVE_PREFIX);
      }
      expect(snippet.description, snippet.id).toMatch(/^[^.!?\n]+[.!?]$/u);
    }
  });

  // Version is pinned beside the hash so a content edit that changes a hash without bumping the
  // snippet's version is visible in the snapshot diff.
  it("pins the canonical managed-block hashes", async () => {
    const hashes = await Promise.all(
      officialContent.snippets.map(async (snippet) => ({
        hash: hashManagedSnippet(await readSnippet(snippet)),
        id: snippet.id,
        version: snippet.version,
      })),
    );

    expect(hashes).toMatchInlineSnapshot(`
      [
        {
          "hash": "840eaf13cce6ec01b080c8e70d2851bca90d4f08e9d35ad88ef41d46e89c01e9",
          "id": "official/commit-conventions",
          "version": "1.0.0",
        },
        {
          "hash": "3ff0026db55f310cd79be0989f0880930cffdf42272d9dc3553e250ada161300",
          "id": "official/ask-before-destructive",
          "version": "1.0.0",
        },
        {
          "hash": "b2b3e41a16a1392d7e31578339569d521121d097049b986ac97dadb1aec48803",
          "id": "official/pr-descriptions",
          "version": "1.0.0",
        },
        {
          "hash": "6f477cbfda99014ffaf6028375232decca79f6fc485729c1bc9a46ef325668c0",
          "id": "official/jira-linking",
          "version": "1.0.0",
        },
        {
          "hash": "8559206b40e6c69d3e0a8ed099c127f3fb0d2a7c3fae70d64c4a427fb35f7aa7",
          "id": "official/confluence-references",
          "version": "1.0.0",
        },
        {
          "hash": "8c4b0731194dea7241669907bf06e508d3cee20e87325b37bfe3e43386e24152",
          "id": "official/typescript-style",
          "version": "1.0.0",
        },
        {
          "hash": "88d1f83c7b7d6d8d826aff833d819ade435335b1fb515c8e34ced726b4e20f86",
          "id": "official/python-style",
          "version": "1.0.0",
        },
      ]
    `);
  });
});

describe("official MCP catalog", () => {
  it("loads every bundled definition through the registry and workspace loader", async () => {
    const registry = createPluginRegistry([officialContent]);
    const scan = await buildWorkspaceModel({
      adapters: [],
      environment: createEnvironment({
        cwd: "/tmp/aura-official-content-test",
        environmentVariables: {},
        homeDir: "/tmp/aura-official-content-test/home",
      }),
      mcpCatalog: registry.mcpServers,
    });

    expect(scan.diagnostics).toEqual([]);
    expect(
      scan.model.availableMcpServers.map((entry) => ({
        id: entry.id,
        serverName: entry.manifest.serverName,
        supportedApps: entry.manifest.supportedApps,
      })),
    ).toEqual([
      {
        id: "official/atlassian-rovo",
        serverName: "atlassian-rovo",
        supportedApps: ["claude-code", "codex", "cursor"],
      },
      {
        id: "official/github",
        serverName: "github",
        supportedApps: ["claude-code", "codex", "cursor"],
      },
      {
        id: "official/sentry",
        serverName: "sentry",
        supportedApps: ["claude-code", "cursor"],
      },
    ]);
  });
});

async function readSnippet(snippet: Snippet): Promise<string> {
  return readFile(new URL(snippet.source.url), "utf8");
}
