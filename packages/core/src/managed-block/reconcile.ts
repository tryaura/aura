import {
  AURA_MANAGED_BLOCK_BEGIN,
  AURA_MANAGED_BLOCK_END,
  AURA_MANAGED_BLOCK_NOTICE,
  AURA_MANAGED_SNIPPET_BEGIN_PREFIX,
  AURA_MANAGED_SNIPPET_END_PREFIX,
  canonicalizeManagedSnippet,
  hashCanonicalManagedSnippet,
  isManagedSnippetId,
} from "./protocol.js";
import { readManagedBlock } from "./read.js";
import { managedSnippetContentProblems, stripManagedMarkers } from "./scan.js";
import { detectLineEnding } from "./source-lines.js";
import type {
  DesiredManagedSnippet,
  ManagedBlockNote,
  ManagedBlockProblem,
  ManagedBlockReadResult,
  ManagedBlockReconcileOptions,
  ManagedBlockWriteResult,
} from "./types.js";

/** A desired snippet that passed validation, canonicalized and hashed exactly once. */
interface PreparedSnippet {
  readonly canonical: string;
  readonly hash: string;
  readonly id: string;
}

type ParsedSource = Exclude<ManagedBlockReadResult, { readonly status: "invalid" }>;

/**
 * Reconciles one source string against the complete ordered set of desired snippets.
 *
 * Existing hash mismatches remain observable through {@link readManagedBlock}, but reconciliation
 * deliberately replaces managed content with the desired canonical version, reporting each
 * discarded hand edit as an `overwritten-snippet` note. Invalid structures fail closed and return
 * the original source unchanged unless the caller opts into `onInvalid: "repair"`.
 */
export function reconcileManagedBlock(
  source: string,
  desiredSnippets: readonly DesiredManagedSnippet[],
  options: ManagedBlockReconcileOptions = {},
): ManagedBlockWriteResult {
  const current = readManagedBlock(source);
  const desired = prepareDesiredSnippets(desiredSnippets);
  if (desired.problems.length > 0) {
    return invalidResult(source, current.notes, desired.problems);
  }

  if (current.status !== "invalid") {
    const notes = [...current.notes, ...overwrittenNotes(current)];
    return settle(source, buildContent(source, desired.prepared, current), notes);
  }
  if (options.onInvalid !== "repair") {
    return invalidResult(source, current.notes, current.problems);
  }

  const stripped = stripManagedMarkers(source);
  const repaired = readManagedBlock(stripped);
  if (repaired.status === "invalid") {
    return invalidResult(source, current.notes, current.problems);
  }
  const notes = [...current.notes, ...repairNotes(current.problems)];
  return settle(source, buildContent(stripped, desired.prepared, repaired), notes);
}

function buildContent(
  source: string,
  prepared: readonly PreparedSnippet[],
  current: ParsedSource,
): string {
  if (prepared.length === 0) {
    return current.status === "absent"
      ? source
      : source.slice(0, current.block.startOffset) +
          current.block.unmanagedContent +
          source.slice(current.block.endOffset);
  }

  const lineEnding = detectLineEnding(source);
  if (current.status === "absent") {
    const separator = source.length === 0 || source.endsWith("\n") ? "" : lineEnding;
    const block = renderManagedBlock(prepared, lineEnding, true);
    return `${source}${separator}${block}`;
  }

  const endsWithLineEnding =
    source[current.block.endOffset - 1] === "\n" || current.block.unmanagedContent.length > 0;
  const replacement = renderManagedBlock(prepared, lineEnding, endsWithLineEnding);
  if (
    current.block.unmanagedContent.length === 0 &&
    replacement === source.slice(current.block.startOffset, current.block.endOffset)
  ) {
    return source;
  }
  return (
    source.slice(0, current.block.startOffset) +
    replacement +
    current.block.unmanagedContent +
    source.slice(current.block.endOffset)
  );
}

function renderManagedBlock(
  snippets: readonly PreparedSnippet[],
  lineEnding: "\n" | "\r\n",
  endsWithLineEnding: boolean,
): string {
  const parts: string[] = [
    AURA_MANAGED_BLOCK_BEGIN,
    lineEnding,
    AURA_MANAGED_BLOCK_NOTICE,
    lineEnding,
  ];

  for (const snippet of snippets) {
    const content =
      lineEnding === "\n" ? snippet.canonical : snippet.canonical.replaceAll("\n", lineEnding);
    parts.push(
      `${AURA_MANAGED_SNIPPET_BEGIN_PREFIX}${snippet.id} sha256=${snippet.hash} -->`,
      lineEnding,
      content,
      `${AURA_MANAGED_SNIPPET_END_PREFIX}${snippet.id} -->`,
      lineEnding,
    );
  }

  parts.push(AURA_MANAGED_BLOCK_END);
  if (endsWithLineEnding) {
    parts.push(lineEnding);
  }
  return parts.join("");
}

interface PreparedDesired {
  readonly prepared: readonly PreparedSnippet[];
  readonly problems: readonly ManagedBlockProblem[];
}

function prepareDesiredSnippets(snippets: readonly DesiredManagedSnippet[]): PreparedDesired {
  const ids = new Set<string>();
  const prepared: PreparedSnippet[] = [];
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
    ids.add(snippet.id);

    const canonical = canonicalizeManagedSnippet(snippet.content);
    problems.push(...managedSnippetContentProblems(snippet.id, canonical));
    prepared.push({ canonical, hash: hashCanonicalManagedSnippet(canonical), id: snippet.id });
  }

  return { prepared, problems: Object.freeze(problems) };
}

function overwrittenNotes(current: ParsedSource): readonly ManagedBlockNote[] {
  if (current.status === "absent") {
    return [];
  }
  return current.block.snippets
    .filter((snippet) => !snippet.hashMatches)
    .map((snippet) =>
      Object.freeze({
        code: "overwritten-snippet" as const,
        line: snippet.startLine,
        message: `Snippet "${snippet.id}" was edited by hand since Aura wrote it; the edit is being replaced.`,
      }),
    );
}

function repairNotes(problems: readonly ManagedBlockProblem[]): readonly ManagedBlockNote[] {
  return problems.map((problem) =>
    Object.freeze({
      code: "repaired-invalid-block" as const,
      line: problem.line,
      message: `Rebuilt the managed block to repair: ${problem.message}`,
    }),
  );
}

function invalidResult(
  source: string,
  notes: readonly ManagedBlockNote[],
  problems: readonly ManagedBlockProblem[],
): ManagedBlockWriteResult {
  return Object.freeze({
    content: source,
    notes: Object.freeze([...notes]),
    problems,
    status: "invalid",
  });
}

function settle(
  source: string,
  content: string,
  notes: readonly ManagedBlockNote[],
): ManagedBlockWriteResult {
  return content === source
    ? Object.freeze({ content: source, notes: Object.freeze([...notes]), status: "unchanged" })
    : Object.freeze({ content, notes: Object.freeze([...notes]), status: "updated" });
}
