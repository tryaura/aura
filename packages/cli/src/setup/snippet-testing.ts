import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readManagedBlock } from "@tryaura/core";
import { defineCheck, definePlugin, type Snippet } from "@tryaura/aura-sdk";

export function snippet(id: string, path: string, category: string, name: string): Snippet {
  return {
    category,
    description: `${name} description.`,
    id,
    kind: "snippet",
    name,
    source: { type: "file", url: pathToFileURL(path).href },
    version: "1.0.0",
  };
}

export function snippetPlugin(snippets: readonly Snippet[]) {
  return definePlugin({
    apiVersion: 1,
    checks: [
      defineCheck({
        defaultSeverity: "info",
        detect: () => [],
        explain: "Fixture check.",
        fixability: "manual",
        id: "fixture/TEST-001",
        scope: "global",
        title: "Fixture passes",
      }),
    ],
    id: "fixture",
    name: "Fixture snippets",
    snippets,
    version: "1.0.0",
  });
}

export async function installedIds(homeDir: string): Promise<readonly string[]> {
  const source = await readFile(join(homeDir, "agents", "AGENTS.md"), "utf8");
  const parsed = readManagedBlock(source);
  if (parsed.status !== "present") {
    return [];
  }
  return parsed.block.snippets.map((entry) => entry.id);
}

export async function manifestIds(homeDir: string): Promise<readonly string[]> {
  return (await manifestSnippets(homeDir)).map((entry) => entry.id);
}

interface ManifestSnippetRecord {
  readonly hash: string;
  readonly id: string;
  readonly pinned: boolean;
  readonly version: string;
}

export async function manifestSnippets(homeDir: string): Promise<readonly ManifestSnippetRecord[]> {
  const source = await readFile(join(homeDir, "agents", "aura.json"), "utf8");
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || !Array.isArray(parsed["snippets"])) {
    throw new Error("Expected manifest snippets.");
  }
  return parsed["snippets"].map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["hash"] !== "string" ||
      typeof entry["id"] !== "string" ||
      typeof entry["pinned"] !== "boolean" ||
      typeof entry["version"] !== "string"
    ) {
      throw new Error("Expected a manifest snippet.");
    }
    return {
      hash: entry["hash"],
      id: entry["id"],
      pinned: entry["pinned"],
      version: entry["version"],
    };
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
