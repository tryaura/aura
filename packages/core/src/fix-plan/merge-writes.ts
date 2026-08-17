import { applyPatch, structuredPatch } from "diff";

interface ChangedSpan {
  readonly end: number;
  readonly insertion: boolean;
  readonly owner: number;
  readonly start: number;
}

export type WriteMergeResult =
  | { readonly content: string; readonly status: "merged" }
  | { readonly reason: string; readonly status: "conflict" };

/** Three-way merges independent complete-file writes against the content they all inspected. */
export function mergeWriteContents(base: string, targets: readonly string[]): WriteMergeResult {
  const uniqueTargets = [...new Set(targets)].filter((target) => target !== base);
  if (uniqueTargets.length === 0) {
    return { content: base, status: "merged" };
  }
  if (uniqueTargets.length === 1) {
    return { content: uniqueTargets[0] ?? base, status: "merged" };
  }

  const patches = uniqueTargets.map((target) =>
    structuredPatch("original", "requested", base, target, undefined, undefined, { context: 0 }),
  );
  const spans: ChangedSpan[] = [];
  for (const [owner, patch] of patches.entries()) {
    for (const hunk of patch.hunks) {
      const span: ChangedSpan = {
        end: hunk.oldStart + hunk.oldLines,
        insertion: hunk.oldLines === 0,
        owner,
        start: hunk.oldStart,
      };
      if (spans.some((existing) => existing.owner !== owner && spansOverlap(existing, span))) {
        return {
          reason: "same-path writes change overlapping lines and cannot be merged safely",
          status: "conflict",
        };
      }
      spans.push(span);
    }
  }

  // Every hunk numbers its lines against `base`, so the patches cannot be applied one at a time:
  // the first one shifts every line below it, and a pure insertion carries no context for
  // `applyPatch` to notice it has landed in the wrong place. Handing over one hunk stream in `base`
  // order instead lets `applyPatch` keep the running offset that makes those numbers mean what they
  // say. The spans above already proved the hunks are disjoint, so the order is total.
  const hunks = patches
    .flatMap((patch) => patch.hunks)
    .sort((left, right) => left.oldStart - right.oldStart);
  const content = applyPatch(
    base,
    {
      hunks,
      newFileName: "requested",
      newHeader: undefined,
      oldFileName: "original",
      oldHeader: undefined,
    },
    { fuzzFactor: 0 },
  );
  if (content === false) {
    return {
      reason: "same-path writes could not be rebased onto their combined result",
      status: "conflict",
    };
  }
  return { content, status: "merged" };
}

function spansOverlap(left: ChangedSpan, right: ChangedSpan): boolean {
  if (left.insertion && right.insertion) {
    return left.start === right.start;
  }
  if (left.insertion) {
    return insertionTouches(left.start, right);
  }
  if (right.insertion) {
    return insertionTouches(right.start, left);
  }
  return left.start < right.end && right.start < left.end;
}

function insertionTouches(point: number, changed: ChangedSpan): boolean {
  return point >= changed.start && point <= changed.end;
}
