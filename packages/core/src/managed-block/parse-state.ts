import type { Marker } from "./markers.js";
import {
  hashManagedSnippet,
  isManagedSnippetId,
  MANAGED_SNIPPET_HASH_PATTERN,
} from "./protocol.js";
import type { SourceLine } from "./source-lines.js";
import type {
  ManagedBlock,
  ManagedBlockProblem,
  ManagedBlockProblemCode,
  ManagedSnippet,
} from "./types.js";

export interface OpenBlock {
  acceptsNotice: boolean;
  readonly snippets: ManagedSnippet[];
  readonly snippetIds: Set<string>;
  readonly start: SourceLine;
  readonly unmanaged: string[];
}

export interface OpenSnippet {
  readonly contentStart: number;
  readonly id: string;
  readonly startLine: number;
  readonly storedHash: string;
}

export function collectMarkerValidation(
  marker: Extract<Marker, { readonly kind: "snippet-begin" | "snippet-end" }>,
  line: SourceLine,
  problems: ManagedBlockProblem[],
): void {
  if (!isManagedSnippetId(marker.id)) {
    addProblem(
      problems,
      "invalid-snippet-id",
      line.number,
      `Snippet ID "${marker.id}" is not safe inside an HTML comment marker.`,
    );
  }
  if (marker.kind === "snippet-begin" && !MANAGED_SNIPPET_HASH_PATTERN.test(marker.hash)) {
    addProblem(
      problems,
      "invalid-hash",
      line.number,
      `Snippet "${marker.id}" must declare a lowercase 64-character SHA-256 hash.`,
    );
  }
}

export function closeSnippet(
  snippet: OpenSnippet,
  end: SourceLine,
  source: string,
): ManagedSnippet {
  const content = source.slice(snippet.contentStart, end.start);
  const computedHash = hashManagedSnippet(content);
  return Object.freeze({
    computedHash,
    content,
    endLine: end.number,
    hashMatches: computedHash === snippet.storedHash,
    id: snippet.id,
    startLine: snippet.startLine,
    storedHash: snippet.storedHash,
  });
}

export function closeBlock(block: OpenBlock, end: SourceLine): ManagedBlock {
  return Object.freeze({
    endLine: end.number,
    endOffset: end.end,
    snippets: Object.freeze(block.snippets),
    startLine: block.start.number,
    startOffset: block.start.start,
    unmanagedContent: block.unmanaged.join(""),
  });
}

export function addProblem(
  problems: ManagedBlockProblem[],
  code: ManagedBlockProblemCode,
  line: number,
  message: string,
): void {
  problems.push(Object.freeze({ code, line, message }));
}
