import type { Snippet } from "@tryaura/aura-sdk";
import { describe, expect, it } from "vitest";

import { buildWorkspaceModel, hashManagedSnippet } from "../index.js";
import { MAX_SNIPPET_BYTES } from "./reader-limits.js";
import { createMemoryReader, createTestEnvironment, DIRECTORY } from "./testing.js";

describe("workspace snippet catalog", () => {
  it("resolves and canonicalizes readable registry snippets", async () => {
    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader: createMemoryReader({ "/plugins/fixture/rule.md": "Rule\r\n\r\n" }),
      snippets: [snippet()],
    });

    expect(model.availableSnippets).toEqual([
      {
        content: "Rule\n",
        description: "Fixture rule",
        hash: hashManagedSnippet("Rule"),
        id: "fixture/rule",
        name: "Rule",
        version: "2.0.0",
      },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("reads each snippet under a bound rather than the unbounded file limit", async () => {
    const reader = createMemoryReader({ "/plugins/fixture/rule.md": "Rule\n" });

    await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader,
      snippets: [snippet()],
    });

    expect(reader.reads).toContain("/plugins/fixture/rule.md");
  });

  it("names every snippet it had to drop, and why", async () => {
    const oversized = "x".repeat(MAX_SNIPPET_BYTES + 1);
    const { diagnostics, model } = await buildWorkspaceModel({
      adapters: [],
      environment: createTestEnvironment(),
      reader: createMemoryReader(
        {
          "/plugins/fixture/directory.md": DIRECTORY,
          "/plugins/fixture/large.md": oversized,
          "/plugins/fixture/marker.md": "<!-- aura:end -->\n",
          "/plugins/fixture/unreadable.md": "Rule\n",
        },
        { problems: { "/plugins/fixture/unreadable.md": "denied" } },
      ),
      snippets: [
        snippet({ id: "fixture/missing", url: "file:///plugins/fixture/missing.md" }),
        snippet({ id: "fixture/directory", url: "file:///plugins/fixture/directory.md" }),
        snippet({ id: "fixture/unreadable", url: "file:///plugins/fixture/unreadable.md" }),
        snippet({ id: "fixture/large", url: "file:///plugins/fixture/large.md" }),
        snippet({ id: "fixture/marker", url: "file:///plugins/fixture/marker.md" }),
        snippet({ id: "fixture/not-a-file", url: "https://example.com/rule.md" }),
      ],
    });

    expect(model.availableSnippets).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'Snippet "fixture/missing" points at a file that does not exist, so its content is unavailable.',
      'Snippet "fixture/directory" points at a directory rather than a Markdown file, so its content is unavailable.',
      'Snippet "fixture/unreadable" could not be read (denied), so its content is unavailable.',
      `Snippet "fixture/large" is larger than the ${String(MAX_SNIPPET_BYTES)} byte snippet limit, so its content is unavailable.`,
      'Snippet "fixture/marker" declares an Aura marker on content line 1. Wrap marker examples in a Markdown fence.',
      'Snippet "fixture/not-a-file" declares a source that is not an absolute file: URL, so its content is unavailable.',
    ]);
    expect(new Set(diagnostics.map((diagnostic) => diagnostic.adapterId))).toEqual(
      new Set(["core/snippets"]),
    );
  });
});

function snippet(overrides: { readonly id?: string; readonly url?: string } = {}): Snippet {
  return {
    description: "Fixture rule",
    id: overrides.id ?? "fixture/rule",
    kind: "snippet",
    name: "Rule",
    source: { type: "file", url: overrides.url ?? "file:///plugins/fixture/rule.md" },
    version: "2.0.0",
  };
}
