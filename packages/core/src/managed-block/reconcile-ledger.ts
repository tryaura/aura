import type { ManagedBlock, ManagedBlockNote, ManagedBlockReconcileOptions } from "./types.js";

/** A desired snippet that has already been canonicalized and hashed. */
export interface PreparedManagedSnippet {
  readonly canonical: string;
  readonly hash: string;
  readonly id: string;
  readonly kind: "desired";
}

/** An existing section this reconciliation does not own or cannot currently resolve. */
interface PreservedManagedSnippet {
  readonly id: string;
  readonly kind: "preserved";
  readonly raw: string;
}

export type RenderedManagedSnippet = PreparedManagedSnippet | PreservedManagedSnippet;

export function renderLedgerSnippets(
  source: string,
  block: ManagedBlock | undefined,
  desired: readonly PreparedManagedSnippet[],
  options: ManagedBlockReconcileOptions,
): readonly RenderedManagedSnippet[] {
  if (block === undefined || options.ownedSnippetIds === undefined) {
    return desired;
  }

  const controlled = controlledSnippetIds(desired, options);
  const preserved = new Set(options.preserveSnippetIds ?? []);
  const remaining = [...desired];
  const rendered: RenderedManagedSnippet[] = [];

  for (const snippet of block.snippets) {
    if (preserved.has(snippet.id) || !controlled.has(snippet.id)) {
      rendered.push({
        id: snippet.id,
        kind: "preserved",
        raw: source.slice(snippet.startOffset, snippet.endOffset),
      });
      continue;
    }

    const replacement = remaining.shift();
    if (replacement !== undefined) {
      rendered.push(replacement);
    }
  }

  rendered.push(...remaining);
  return rendered;
}

export function controlledSnippetIds(
  desired: readonly PreparedManagedSnippet[],
  options: ManagedBlockReconcileOptions,
): ReadonlySet<string> {
  return new Set([...(options.ownedSnippetIds ?? []), ...desired.map((snippet) => snippet.id)]);
}

export function preservedUnownedNotes(
  block: ManagedBlock | undefined,
  desired: readonly PreparedManagedSnippet[],
  options: ManagedBlockReconcileOptions,
): readonly ManagedBlockNote[] {
  if (block === undefined || options.ownedSnippetIds === undefined) {
    return [];
  }
  const controlled = controlledSnippetIds(desired, options);
  return block.snippets
    .filter((snippet) => !controlled.has(snippet.id))
    .map((snippet) =>
      Object.freeze({
        code: "preserved-unowned-snippet" as const,
        line: snippet.startLine,
        message: `Snippet "${snippet.id}" is not recorded in Aura's manifest; its section was preserved.`,
      }),
    );
}
