import { open } from "node:fs/promises";

import type { AuraManifestState, Snippet } from "@tryaura/aura-sdk";

export type SnippetCatalogEntry = AvailableSnippetCatalogEntry | UnavailableSnippetCatalogEntry;

interface SnippetCatalogEntryBase {
  readonly category: string;
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

interface AvailableSnippetCatalogEntry extends SnippetCatalogEntryBase {
  readonly content: string;
  readonly status: "available";
}

interface UnavailableSnippetCatalogEntry extends SnippetCatalogEntryBase {
  readonly reason: string;
  readonly status: "unavailable";
}

/**
 * A snippet's whole body is spliced into the user's instruction file and held in memory for the
 * rest of the run, so a plugin cannot hand us an arbitrarily large one.
 */
const MAX_SNIPPET_BYTES = 64 * 1024;

/**
 * The registry's snippets, read at most once and only if some step asks for them.
 *
 * Resolution costs one file read per registered snippet, which is wasted work for a run that
 * aborts before the snippet step or omits it entirely — so it is deferred until {@link load}.
 */
export interface SnippetCatalog {
  /** Everything {@link load} resolved, or nothing if it was never awaited. */
  readonly entries: () => readonly SnippetCatalogEntry[];
  /** Resolves every registry source once; later calls reuse the first result. */
  readonly load: () => Promise<readonly SnippetCatalogEntry[]>;
}

export function createSnippetCatalog(
  snippets: readonly Snippet[],
  manifest: AuraManifestState,
  presetIds: readonly string[] = [],
): SnippetCatalog {
  let resolved: readonly SnippetCatalogEntry[] = [];
  let pending: Promise<readonly SnippetCatalogEntry[]> | undefined;

  return {
    entries: () => resolved,
    load: () => {
      pending ??= resolveSnippetCatalog(snippets, manifest, presetIds).then((entries) => {
        resolved = entries;
        return entries;
      });
      return pending;
    },
  };
}

/** Resolves every registry source once and retains manifest-only selections as unavailable rows. */
export async function resolveSnippetCatalog(
  snippets: readonly Snippet[],
  manifest: AuraManifestState,
  presetIds: readonly string[] = [],
): Promise<readonly SnippetCatalogEntry[]> {
  const registered = new Set(snippets.map((snippet) => snippet.id));
  const resolved = await Promise.all(snippets.map(resolveSnippet));
  const previous = manifest.status === "ready" ? manifest.value.snippets : [];
  const previousIds = new Set(previous.map((snippet) => snippet.id));
  return Object.freeze([
    ...resolved,
    ...previous
      .filter((snippet) => !registered.has(snippet.id))
      .map((snippet): UnavailableSnippetCatalogEntry =>
        Object.freeze({
          category: "general",
          description: "Previously selected, but no installed plugin currently provides it.",
          id: snippet.id,
          name: snippet.id,
          reason: "The contributing plugin is unavailable.",
          status: "unavailable",
          version: snippet.version,
        }),
      ),
    ...presetIds
      .filter((id) => !registered.has(id) && !previousIds.has(id))
      .map((id): UnavailableSnippetCatalogEntry =>
        Object.freeze({
          category: "general",
          description: "Selected by the active team preset, but unavailable in this build.",
          id,
          name: id,
          reason: "No installed plugin provides this preset selection.",
          status: "unavailable",
          version: "unknown",
        }),
      ),
  ]);
}

async function resolveSnippet(snippet: Snippet): Promise<SnippetCatalogEntry> {
  const common: SnippetCatalogEntryBase = {
    category: snippet.category ?? "general",
    description: snippet.description,
    id: snippet.id,
    name: snippet.name,
    version: snippet.version,
  };
  try {
    const source = new URL(snippet.source.url);
    if (source.protocol !== "file:") {
      throw new Error(`Expected a file: URL, received ${source.protocol}`);
    }
    return Object.freeze({
      ...common,
      content: await readBoundedSource(source),
      status: "available",
    });
  } catch (error) {
    return Object.freeze({ ...common, reason: errorMessage(error), status: "unavailable" });
  }
}

/** Measures the open file rather than the path, so the size cannot change between the two calls. */
async function readBoundedSource(source: URL): Promise<string> {
  const handle = await open(source, "r");
  try {
    const { size } = await handle.stat();
    if (size > MAX_SNIPPET_BYTES) {
      throw new Error(
        `Source is ${String(Math.ceil(size / 1024))} KiB; snippets are limited to ${String(MAX_SNIPPET_BYTES / 1024)} KiB.`,
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
