import { access, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWorkspaceModel, createEnvironment, createPluginRegistry } from "@tryaura/core";
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

/** The directory `build-binary.mjs` copies wholesale into the compiled binary. */
const CONTENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "content");

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

  /**
   * The compiled binary embeds a directory, not a list: `build-binary.mjs` copies `content/` and
   * hands every file under it to `bun build` as an asset. Anything registered from outside that
   * tree resolves here, where the package is a directory on disk, and is simply missing from the
   * binary — which the release lane only notices once the artifact exists.
   */
  it("registers every source from the tree the binary embeds", async () => {
    for (const source of [...officialContent.snippets, ...officialContent.mcpCatalog]) {
      const path = fileURLToPath(source.source.url);

      expect(path.startsWith(`${CONTENT_ROOT}${sep}`), source.id).toBe(true);
      await expect(access(path), source.id).resolves.toBeUndefined();
    }
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
