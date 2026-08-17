import { resolve } from "node:path";

import type { InstructionDocument, Scope } from "@tryaura/aura-sdk";

import { compareCodePoints } from "./ordering.js";

/**
 * Sorts adapter documents and keeps one per physical file.
 *
 * Documents are deduplicated on {@link InstructionDocument.canonicalPath}, not on the path the
 * adapter declared: a dotfile setup that symlinks `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` at
 * one shared source hands two applications the same bytes through two names, and every check built
 * on this list would otherwise report that file as duplicating, contradicting, or double-counting
 * itself. Which name survives is the first in sorted order, so a run over an unchanged machine
 * reports the same one twice. Core leaves `canonicalPath` unset only when the path did not resolve,
 * where the declared path is the whole of what is known about it.
 */
export function canonicalInstructionDocuments(
  documents: readonly InstructionDocument[],
  scope?: Scope,
): readonly InstructionDocument[] {
  const sorted = documents
    .filter((document) => scope === undefined || document.scope === scope)
    .map((document) => ({ canonical: canonicalPath(document), document }))
    .sort(
      (left, right) =>
        compareCodePoints(left.canonical, right.canonical) ||
        compareCodePoints(resolve(left.document.path), resolve(right.document.path)) ||
        compareCodePoints(left.document.sourceId, right.document.sourceId) ||
        compareCodePoints(left.document.scope, right.document.scope) ||
        compareCodePoints(left.document.content, right.document.content),
    );
  const seen = new Set<string>();

  return sorted.flatMap(({ canonical, document }) => {
    if (seen.has(canonical)) {
      return [];
    }
    seen.add(canonical);
    return [document];
  });
}

function canonicalPath(document: InstructionDocument): string {
  return document.canonicalPath ?? resolve(document.path);
}
