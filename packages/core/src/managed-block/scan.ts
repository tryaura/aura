import { parseMarker } from "./markers.js";
import { AURA_MANAGED_BLOCK_NOTICE } from "./protocol.js";
import { advanceMarkdownFence, type MarkdownFence, splitSourceLines } from "./source-lines.js";
import type { ManagedBlockProblem } from "./types.js";

interface MarkerScan {
  /** One-based line of the first marker the reader would honour, if any. */
  readonly markerLine: number | undefined;
  /** Whether the text ends inside a fence the reader would still consider open. */
  readonly unterminatedFence: boolean;
}

/**
 * Finds protocol markers the reader would honour, applying the same fence rules as
 * {@link readManagedBlock} so fenced marker examples stay ordinary text.
 */
function scanForMarkers(text: string): MarkerScan {
  let fence: MarkdownFence | undefined;
  let markerLine: number | undefined;

  for (const line of splitSourceLines(text)) {
    const previousFence = fence;
    fence = advanceMarkdownFence(line.text, fence);
    if (previousFence !== undefined || fence !== undefined) {
      continue;
    }
    if (markerLine === undefined && parseMarker(line.text) !== undefined) {
      markerLine = line.number;
    }
  }

  return { markerLine, unterminatedFence: fence !== undefined };
}

/**
 * Rejects content that would escape its own snippet. Written verbatim, a marker inside a snippet
 * body reopens or closes the protocol, and the resulting file parses as invalid forever — so the
 * damage has to be caught before the write, not after.
 *
 * Every write path shares this guard. A narrower path that skipped it would be a way to write the
 * exact bytes the wider one refuses, and the file it corrupts is the same file either way.
 */
export function managedSnippetContentProblems(
  id: string,
  canonical: string,
): readonly ManagedBlockProblem[] {
  const scan = scanForMarkers(canonical);
  if (scan.markerLine !== undefined) {
    return Object.freeze([
      Object.freeze({
        code: "invalid-snippet-content" as const,
        message: `Snippet "${id}" declares an Aura marker on content line ${String(scan.markerLine)}. Wrap marker examples in a Markdown fence.`,
      }),
    ]);
  }
  if (scan.unterminatedFence) {
    return Object.freeze([
      Object.freeze({
        code: "invalid-snippet-content" as const,
        message: `Snippet "${id}" ends inside an unclosed Markdown fence, which would hide every marker after it. Close the fence.`,
      }),
    ]);
  }
  return Object.freeze([]);
}

/**
 * Drops every protocol line the reader honours, plus the notice that follows an opening marker,
 * leaving handwritten text byte-for-byte. Fenced marker examples survive because the reader never
 * treated them as protocol in the first place.
 */
export function stripManagedMarkers(source: string): string {
  const kept: string[] = [];
  let fence: MarkdownFence | undefined;
  let afterBlockBegin = false;

  for (const line of splitSourceLines(source)) {
    const previousFence = fence;
    fence = advanceMarkdownFence(line.text, fence);
    const protectedByFence = previousFence !== undefined || fence !== undefined;
    const marker = protectedByFence ? undefined : parseMarker(line.text);

    if (marker !== undefined) {
      afterBlockBegin = marker.kind === "block-begin";
      continue;
    }
    if (afterBlockBegin && line.text === AURA_MANAGED_BLOCK_NOTICE) {
      afterBlockBegin = false;
      continue;
    }
    afterBlockBegin = false;
    kept.push(source.slice(line.start, line.end));
  }

  return kept.join("");
}
