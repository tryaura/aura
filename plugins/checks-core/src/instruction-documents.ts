import { resolve } from "node:path";

import type { InstructionDocument, Scope } from "@tryaura/aura-sdk";

import { compareCodePoints } from "./ordering.js";

/** Sorts and deduplicates adapter documents by their resolved path. */
export function canonicalInstructionDocuments(
  documents: readonly InstructionDocument[],
  scope?: Scope,
): readonly InstructionDocument[] {
  const sorted = documents
    .filter((document) => scope === undefined || document.scope === scope)
    .sort(
      (left, right) =>
        compareCodePoints(resolve(left.path), resolve(right.path)) ||
        compareCodePoints(left.sourceId, right.sourceId) ||
        compareCodePoints(left.scope, right.scope) ||
        compareCodePoints(left.content, right.content),
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
