import {
  AURA_MANAGED_BLOCK_BEGIN,
  AURA_MANAGED_BLOCK_END,
  AURA_MANAGED_BLOCK_NOTICE,
  AURA_MANAGED_SNIPPET_BEGIN_PREFIX,
  AURA_MANAGED_SNIPPET_END_PREFIX,
} from "./protocol.js";
import { readManagedBlock } from "./read.js";
import { prepareDesiredSnippets } from "./reconcile-desired.js";
import {
  controlledSnippetIds,
  type PreparedManagedSnippet,
  preservedUnownedNotes,
  type RenderedManagedSnippet,
  renderLedgerSnippets,
} from "./reconcile-ledger.js";
import { stripManagedMarkers } from "./scan.js";
import { detectLineEnding } from "./source-lines.js";
import type {
  DesiredManagedSnippet,
  ManagedBlockNote,
  ManagedBlockProblem,
  ManagedBlockReadResult,
  ManagedBlockReconcileOptions,
  ManagedBlockWriteResult,
} from "./types.js";

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
  return reconcileParsedManagedBlock(source, readManagedBlock(source), desiredSnippets, options);
}

/**
 * {@link reconcileManagedBlock}, for a caller that already parsed `source`.
 *
 * `current` must be `readManagedBlock(source)` for the same string; passing a result read from
 * anything else splices content at offsets that no longer describe the source.
 */
export function reconcileParsedManagedBlock(
  source: string,
  current: ManagedBlockReadResult,
  desiredSnippets: readonly DesiredManagedSnippet[],
  options: ManagedBlockReconcileOptions = {},
): ManagedBlockWriteResult {
  const desired = prepareDesiredSnippets(desiredSnippets, options);
  if (desired.problems.length > 0) {
    return invalidResult(source, current.notes, desired.problems);
  }

  const hiddenMarker = current.notes.find((note) => note.code === "unterminated-fence");
  if (hiddenMarker !== undefined) {
    return invalidResult(source, current.notes, [
      Object.freeze({
        code: "unterminated-fence",
        line: hiddenMarker.line,
        message: hiddenMarker.message,
      }),
    ]);
  }

  if (current.status !== "invalid") {
    const block = current.status === "present" ? current.block : undefined;
    const rendered = renderLedgerSnippets(source, block, desired.prepared, options);
    const notes = [
      ...current.notes,
      ...overwrittenNotes(current, desired.prepared, options),
      ...preservedUnownedNotes(block, desired.prepared, options),
    ];
    return settle(source, buildContent(source, rendered, current), notes);
  }
  if (options.onInvalid !== "repair") {
    return invalidResult(source, current.notes, current.problems);
  }
  // Once parsing failed there is no reliable block ledger to distinguish owned sections from
  // sections that must survive byte-for-byte. Repairing under a ledger would preserve their text
  // but erase their markers and ownership, so fail closed instead.
  if (options.ownedSnippetIds !== undefined) {
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
  prepared: readonly RenderedManagedSnippet[],
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
  snippets: readonly RenderedManagedSnippet[],
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
    if (snippet.kind === "preserved") {
      parts.push(snippet.raw);
      continue;
    }
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

function overwrittenNotes(
  current: ParsedSource,
  desired: readonly PreparedManagedSnippet[],
  options: ManagedBlockReconcileOptions,
): readonly ManagedBlockNote[] {
  if (current.status === "absent") {
    return [];
  }
  const controlled = controlledSnippetIds(desired, options);
  const desiredById = new Map(desired.map((snippet) => [snippet.id, snippet]));
  const preserved = new Set(options.preserveSnippetIds ?? []);
  return current.block.snippets.flatMap((snippet): readonly ManagedBlockNote[] => {
    if (
      (options.ownedSnippetIds !== undefined && !controlled.has(snippet.id)) ||
      preserved.has(snippet.id) ||
      !handEdited(snippet, options)
    ) {
      return [];
    }

    const replacement = desiredById.get(snippet.id);
    // Dropping a section destroys the hand edit just as surely as writing over it does, so it gets
    // its own note rather than none: the point of this notice is that work is about to be lost.
    if (replacement === undefined) {
      return [
        Object.freeze({
          code: "removed-snippet" as const,
          line: snippet.startLine,
          message: `Snippet "${snippet.id}" was edited by hand since Aura wrote it; the edit is being removed.`,
        }),
      ];
    }
    if (replacement.hash === snippet.computedHash) {
      return [];
    }
    return [
      Object.freeze({
        code: "overwritten-snippet" as const,
        line: snippet.startLine,
        message: `Snippet "${snippet.id}" was edited by hand since Aura wrote it; the edit is being replaced.`,
      }),
    ];
  });
}

/**
 * Whether a section differs from what Aura last recorded for it.
 *
 * The marker hash is written by whoever wrote the marker, so a re-stamped section certifies itself
 * and `hashMatches` alone cannot tell a hand edit from a catalog upgrade. The manifest is the only
 * record the editor did not control; fall back to the marker only when there is no manifest entry.
 */
function handEdited(
  snippet: { readonly computedHash: string; readonly hashMatches: boolean; readonly id: string },
  options: ManagedBlockReconcileOptions,
): boolean {
  const previousHash = options.previousSnippetHashes?.get(snippet.id);
  return previousHash === undefined ? !snippet.hashMatches : previousHash !== snippet.computedHash;
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
