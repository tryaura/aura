import {
  canonicalizeManagedSnippet,
  hashCanonicalManagedSnippet,
  isManagedSnippetId,
} from "./protocol.js";
import type { PreparedManagedSnippet } from "./reconcile-ledger.js";
import { managedSnippetContentProblems } from "./scan.js";
import type {
  DesiredManagedSnippet,
  ManagedBlockProblem,
  ManagedBlockReconcileOptions,
} from "./types.js";

/** The desired set, canonicalized and hashed, alongside everything wrong with it. */
export interface PreparedDesired {
  readonly prepared: readonly PreparedManagedSnippet[];
  readonly problems: readonly ManagedBlockProblem[];
}

export function prepareDesiredSnippets(
  snippets: readonly DesiredManagedSnippet[],
  options: ManagedBlockReconcileOptions,
): PreparedDesired {
  const ids = new Set<string>();
  const preserved = new Set(options.preserveSnippetIds ?? []);
  const prepared: PreparedManagedSnippet[] = [];
  const problems: ManagedBlockProblem[] = [];

  for (const snippet of snippets) {
    if (!isManagedSnippetId(snippet.id)) {
      problems.push(
        Object.freeze({
          code: "invalid-snippet-id",
          message: `Snippet ID "${snippet.id}" is not safe inside an HTML comment marker.`,
        }),
      );
    }
    if (ids.has(snippet.id)) {
      problems.push(
        Object.freeze({
          code: "duplicate-snippet",
          message: `Desired snippet ID "${snippet.id}" appears more than once.`,
        }),
      );
    }
    // Rendering the desired snippet and preserving the existing section would emit the ID twice,
    // and a block with a repeated ID never parses again. The conflict has to fail before the write.
    if (preserved.has(snippet.id)) {
      problems.push(
        Object.freeze({
          code: "duplicate-snippet",
          message: `Snippet ID "${snippet.id}" is both desired and preserved; writing both would duplicate it.`,
        }),
      );
    }
    ids.add(snippet.id);

    const canonical = canonicalizeManagedSnippet(snippet.content);
    problems.push(...managedSnippetContentProblems(snippet.id, canonical));
    prepared.push({
      canonical,
      hash: hashCanonicalManagedSnippet(canonical),
      id: snippet.id,
      kind: "desired",
    });
  }

  return { prepared, problems: Object.freeze(problems) };
}
