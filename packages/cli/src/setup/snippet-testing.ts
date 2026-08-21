import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
    apiVersion: 2,
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

export async function manifestIds(homeDir: string): Promise<readonly string[]> {
  return (await manifestSnippets(homeDir)).map((entry) => {
    if (typeof entry["id"] !== "string") {
      throw new Error("Expected a manifest snippet record.");
    }
    return entry["id"];
  });
}

/** The recorded fingerprints, for a test asserting Aura kept a handle on what it appended. */
export async function manifestSnippetHashes(homeDir: string): Promise<ReadonlyMap<string, string>> {
  return new Map(
    (await manifestSnippets(homeDir)).flatMap((entry) =>
      typeof entry["id"] === "string" && typeof entry["hash"] === "string"
        ? [[entry["id"], entry["hash"]] as const]
        : [],
    ),
  );
}

async function manifestSnippets(homeDir: string): Promise<readonly Record<string, unknown>[]> {
  const source = await readFile(join(homeDir, "agents", "aura.json"), "utf8");
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed) || !Array.isArray(parsed["snippets"])) {
    throw new Error("Expected manifest snippets.");
  }
  return parsed["snippets"].map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Expected a manifest snippet record.");
    }
    return entry;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
