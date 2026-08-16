import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { AuraManifestState, Snippet } from "@tryaura/aura-sdk";

import { resolveSnippetCatalog } from "./snippets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("snippet catalog resolution", () => {
  it("loads available files, defaults categories, and retains failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-snippet-catalog-"));
    temporaryDirectories.push(root);
    const available = join(root, "available.md");
    await writeFile(available, "Use pnpm\n", "utf8");

    const catalog = await resolveSnippetCatalog(
      [
        snippet("official/available", pathToFileURL(available).href, "package-management"),
        snippet("official/missing", pathToFileURL(join(root, "missing.md")).href),
      ],
      missingManifest(),
    );

    expect(catalog[0]).toMatchObject({
      category: "package-management",
      content: "Use pnpm\n",
      status: "available",
    });
    expect(catalog[1]).toMatchObject({ category: "general", status: "unavailable" });
  });

  it("refuses a source too large to splice into an instruction file", async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-snippet-catalog-"));
    temporaryDirectories.push(root);
    const oversized = join(root, "oversized.md");
    await writeFile(oversized, "x".repeat(64 * 1024 + 1), "utf8");

    const catalog = await resolveSnippetCatalog(
      [snippet("official/oversized", pathToFileURL(oversized).href)],
      missingManifest(),
    );

    expect(catalog[0]).toMatchObject({
      reason: "Source is 65 KiB; snippets are limited to 64 KiB.",
      status: "unavailable",
    });
  });

  it("appends manifest-only selections as unavailable entries", async () => {
    const catalog = await resolveSnippetCatalog([], readyManifest("retired/rules"));

    expect(catalog).toEqual([
      {
        category: "general",
        description: "Previously selected, but no installed plugin currently provides it.",
        id: "retired/rules",
        name: "retired/rules",
        reason: "The contributing plugin is unavailable.",
        status: "unavailable",
        version: "1.2.3",
      },
    ]);
  });
});

function snippet(id: string, url: string, category?: string): Snippet {
  return {
    ...(category === undefined ? {} : { category }),
    description: `Description for ${id}.`,
    id,
    kind: "snippet",
    name: id,
    source: { type: "file", url },
    version: "1.0.0",
  };
}

function missingManifest(): AuraManifestState {
  return { exists: false, path: "/home/dev/agents/aura.json", status: "missing" };
}

function readyManifest(id: string): AuraManifestState {
  return {
    exists: true,
    path: "/home/dev/agents/aura.json",
    status: "ready",
    value: {
      apps: {},
      mcpServers: [],
      ownership: {},
      schemaVersion: 1,
      skills: [],
      snippets: [{ hash: "a".repeat(64), id, pinned: false, version: "1.2.3" }],
    },
  };
}
