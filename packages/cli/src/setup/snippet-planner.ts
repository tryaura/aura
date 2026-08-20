import type { AuraManifestSnippet } from "@tryaura/aura-sdk";
import { appendInstructionFragments, hashContent } from "@tryaura/core";

import type { SetupNotice } from "./planner.js";
import type { SnippetCatalogEntry } from "./snippets.js";
import type { SetupStepContext } from "./types.js";

export interface SnippetPlan {
  readonly content: string;
  readonly manifestSnippets: readonly AuraManifestSnippet[];
  readonly notices: readonly SetupNotice[];
  readonly updated: boolean;
}

type AvailableSnippet = Extract<SnippetCatalogEntry, { readonly status: "available" }>;

/** Appends newly selected Markdown and treats the manifest as install history, never desired text. */
export function planSnippets(context: SetupStepContext, source: string): SnippetPlan {
  const previous = context.manifest.status === "ready" ? context.manifest.value.snippets : [];
  const selection = context.selections.snippets;
  if (selection === undefined) {
    return { content: source, manifestSnippets: previous, notices: [], updated: false };
  }

  const installed = new Set(previous.map((entry) => entry.id));
  const catalog = new Map(context.snippetCatalog.entries().map((entry) => [entry.id, entry]));
  const selected = selection.selected
    .filter((id) => !installed.has(id))
    .map((id) => catalog.get(id))
    .filter((entry): entry is SnippetCatalogEntry => entry !== undefined);
  // Partitioned rather than refused as a whole: a selection Aura cannot resolve says nothing about
  // the ones it can, and a preset naming a snippet whose plugin is absent would otherwise cancel
  // every other snippet in the same answer on every run, with no way to clear it under `--yes`.
  const available = selected.filter(
    (entry): entry is AvailableSnippet => entry.status === "available",
  );
  const skipped = selected.filter((entry) => entry.status === "unavailable");

  const content = appendInstructionFragments(
    source,
    available.map((entry) => entry.content),
  );
  return {
    content,
    // Install history only grows: a record Aura dropped would be a row offering to append text the
    // file may well still contain, with no marker left to tell whether it does.
    manifestSnippets: [
      ...previous,
      ...available.map((entry) => ({ hash: hashContent(entry.content), id: entry.id })),
    ],
    notices: skipped.map((entry) => ({
      // Not a blocker: nothing about the state of a file is refusing the write, so failing the
      // whole run over a plugin that is merely absent would strand every other selection with it.
      kind: "skipped" as const,
      message: `${entry.id} was selected but not added: ${entry.reason}`,
    })),
    updated: content !== source,
  };
}
