import { createTwoFilesPatch } from "diff";

import {
  AURA_MANAGED_SNIPPET_BEGIN_PREFIX,
  canonicalizeManagedSnippet,
  hashCanonicalManagedSnippet,
} from "./protocol.js";
import { readManagedBlock } from "./read.js";
import { managedSnippetContentProblems } from "./scan.js";
import type {
  ManagedBlockNote,
  ManagedBlockProblem,
  ManagedBlockWriteResult,
  ManagedSnippetResolution,
} from "./types.js";

/** Reconciles exactly one snippet while preserving every other source byte. */
export function reconcileManagedSnippet(
  source: string,
  snippetId: string,
  resolution: ManagedSnippetResolution,
): ManagedBlockWriteResult {
  const current = readManagedBlock(source);
  if (current.status === "invalid") {
    return invalidResult(source, current.notes, current.problems);
  }
  if (current.status === "absent") {
    return missingSnippet(source, current.notes, snippetId, "an Aura-managed block");
  }

  const snippet = current.block.snippets.find((candidate) => candidate.id === snippetId);
  if (snippet === undefined) {
    return missingSnippet(source, current.notes, snippetId, "the Aura-managed block");
  }

  const lineEnding = markerLineEnding(source, snippet.startOffset, snippet.contentStartOffset);
  const canonical =
    resolution.kind === "restore" ? canonicalizeManagedSnippet(resolution.content) : undefined;
  // Replacement content is the only text here that did not already survive the reader. Whole-block
  // reconciliation refuses marker-bearing bodies for a reason, and a targeted write into the same
  // file has to refuse them on the same terms.
  if (canonical !== undefined) {
    const problems = managedSnippetContentProblems(snippet.id, canonical);
    if (problems.length > 0) {
      return invalidResult(source, current.notes, problems);
    }
  }
  const content = canonical === undefined ? snippet.content : withLineEnding(canonical, lineEnding);
  const hash =
    canonical === undefined ? snippet.computedHash : hashCanonicalManagedSnippet(canonical);
  const opening = `${AURA_MANAGED_SNIPPET_BEGIN_PREFIX}${snippet.id} sha256=${hash} -->${lineEnding}`;
  const updated =
    source.slice(0, snippet.startOffset) +
    opening +
    content +
    source.slice(snippet.contentEndOffset);
  return updated === source
    ? Object.freeze({ content: source, notes: current.notes, status: "unchanged" })
    : Object.freeze({ content: updated, notes: current.notes, status: "updated" });
}

/** Creates the opt-in edited-versus-canonical detail used by the merge choice. */
export function diffManagedSnippet(
  path: string,
  editedContent: string,
  canonicalContent: string,
): string {
  return createTwoFilesPatch(
    `${path} (edited)`,
    `${path} (canonical)`,
    editedContent,
    canonicalizeManagedSnippet(canonicalContent),
    "edited",
    "canonical",
    { context: 3 },
  );
}

function missingSnippet(
  source: string,
  notes: readonly ManagedBlockNote[],
  snippetId: string,
  location: string,
): ManagedBlockWriteResult {
  return invalidResult(source, notes, [
    Object.freeze({
      code: "missing-snippet",
      message: `Snippet "${snippetId}" does not exist in ${location}.`,
    }),
  ]);
}

function invalidResult(
  source: string,
  notes: readonly ManagedBlockNote[],
  problems: readonly ManagedBlockProblem[],
): ManagedBlockWriteResult {
  return Object.freeze({ content: source, notes, problems, status: "invalid" });
}

function markerLineEnding(
  source: string,
  startOffset: number,
  contentStartOffset: number,
): "\n" | "\r\n" {
  return source.slice(startOffset, contentStartOffset).endsWith("\r\n") ? "\r\n" : "\n";
}

function withLineEnding(content: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\n" ? content : content.replaceAll("\n", lineEnding);
}
