import { resolve } from "node:path";

import type { InstructionDocument, Scope } from "@tryaura/aura-sdk";

/** Sorts and deduplicates adapter documents by their resolved path. */
export function canonicalInstructionDocuments(
  documents: readonly InstructionDocument[],
  scope?: Scope,
): readonly InstructionDocument[] {
  const sorted = documents
    .filter((document) => scope === undefined || document.scope === scope)
    .sort(
      (left, right) =>
        resolve(left.path).localeCompare(resolve(right.path)) ||
        left.sourceId.localeCompare(right.sourceId) ||
        left.scope.localeCompare(right.scope) ||
        left.content.localeCompare(right.content),
    );
  const paths = new Set<string>();

  return sorted.filter((document) => {
    const path = resolve(document.path);
    if (paths.has(path)) {
      return false;
    }
    paths.add(path);
    return true;
  });
}
