import type { InstructionParagraph } from "./paragraphs.js";

const LENGTH_RATIO = 0.7;
export const NEAR_DUPLICATE_THRESHOLD = 0.85;

export interface ParagraphMatch {
  readonly kind: "exact" | "near";
  readonly left: number;
  readonly right: number;
  readonly similarity: number;
}

/** Finds exact and near-duplicate edges between paragraphs from distinct compatible files. */
export function findMatches(
  paragraphs: readonly InstructionParagraph[],
): readonly ParagraphMatch[] {
  const matches = exactMatches(paragraphs);
  const shingles = new Map<number, ReadonlySet<string>>();

  /** Built on demand: the length band rejects most paragraphs before they are ever compared. */
  const shinglesFor = (index: number, paragraph: InstructionParagraph): ReadonlySet<string> => {
    const cached = shingles.get(index);
    if (cached !== undefined) {
      return cached;
    }
    const computed = tokenShingles(paragraph.normalized);
    shingles.set(index, computed);
    return computed;
  };

  for (const [left, right] of lengthBandPairs(paragraphs)) {
    const leftParagraph = paragraphs[left];
    const rightParagraph = paragraphs[right];
    if (
      leftParagraph === undefined ||
      rightParagraph === undefined ||
      // Equal hashes are already an exact match, or were rejected as one for the same reason a
      // near match would be.
      leftParagraph.hash === rightParagraph.hash ||
      !canCompare(leftParagraph, rightParagraph)
    ) {
      continue;
    }
    const similarity = jaccard(
      shinglesFor(left, leftParagraph),
      shinglesFor(right, rightParagraph),
    );
    if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
      matches.push(orderedMatch({ kind: "near", left, right, similarity }));
    }
  }

  return matches.sort(compareMatches);
}

/**
 * Yields paragraph pairs inside the configured normalized-length window.
 *
 * The pair count is quadratic in the number of same-length paragraphs, which a monorepo full of
 * per-package instruction files reaches easily. Yielding keeps that cost in time only: collecting
 * the pairs first would hold millions of tuples for a workspace that produces a handful of
 * findings.
 */
export function* lengthBandPairs(
  paragraphs: readonly InstructionParagraph[],
): Generator<readonly [number, number]> {
  const byLength = paragraphs
    .map((paragraph, index) => ({ index, length: paragraph.normalized.length }))
    .sort((left, right) => left.length - right.length || left.index - right.index);

  for (let leftIndex = 0; leftIndex < byLength.length; leftIndex += 1) {
    const left = byLength[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < byLength.length; rightIndex += 1) {
      const right = byLength[rightIndex];
      if (right === undefined) {
        continue;
      }
      if (left.length / right.length < LENGTH_RATIO) {
        break;
      }
      yield left.index < right.index ? [left.index, right.index] : [right.index, left.index];
    }
  }
}

export function tokenShingles(normalized: string): ReadonlySet<string> {
  const tokens = normalized.split(" ").filter((token) => token.length > 0);
  const shingles = new Set<string>();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    shingles.add(tokens.slice(index, index + 3).join("\u0000"));
  }
  return shingles;
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function exactMatches(paragraphs: readonly InstructionParagraph[]): ParagraphMatch[] {
  return [...exactBuckets(paragraphs).values()].flatMap((indexes) =>
    exactBucketMatches(indexes, paragraphs),
  );
}

function exactBuckets(paragraphs: readonly InstructionParagraph[]): ReadonlyMap<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    if (paragraph !== undefined) {
      const bucket = buckets.get(paragraph.hash) ?? [];
      bucket.push(index);
      buckets.set(paragraph.hash, bucket);
    }
  }
  return buckets;
}

function exactBucketMatches(
  indexes: readonly number[],
  paragraphs: readonly InstructionParagraph[],
): readonly ParagraphMatch[] {
  const matches: ParagraphMatch[] = [];
  for (let left = 0; left < indexes.length; left += 1) {
    for (let right = left + 1; right < indexes.length; right += 1) {
      const match = exactPair(indexes[left], indexes[right], paragraphs);
      if (match !== undefined) {
        matches.push(match);
      }
    }
  }
  return matches;
}

function exactPair(
  left: number | undefined,
  right: number | undefined,
  paragraphs: readonly InstructionParagraph[],
): ParagraphMatch | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  const leftParagraph = paragraphs[left];
  const rightParagraph = paragraphs[right];
  if (
    leftParagraph === undefined ||
    rightParagraph === undefined ||
    !canCompare(leftParagraph, rightParagraph)
  ) {
    return undefined;
  }
  return { kind: "exact", left, right, similarity: 1 };
}

/**
 * Decides whether two paragraphs are even candidates for being the same guidance.
 *
 * Repetition inside one file is a style choice, not a synchronization hazard, so only distinct
 * paths are compared. Paragraphs whose embedded code differs are different instructions however
 * alike their prose reads — see {@link InstructionParagraph.code}. A conditional rule applies only
 * when its condition holds, so restating guidance in one is deliberate unless the other rule
 * reaches the same audience; comparing those only within a scope keeps a user-level rule from
 * being blamed for a repository's copy, without leaving duplicates between two user-level rules
 * unreported.
 */
function canCompare(left: InstructionParagraph, right: InstructionParagraph): boolean {
  if (left.path === right.path || left.code !== right.code) {
    return false;
  }
  if (!left.conditional && !right.conditional) {
    return true;
  }
  return left.scope === right.scope;
}

function orderedMatch(match: ParagraphMatch): ParagraphMatch {
  return match.left < match.right ? match : { ...match, left: match.right, right: match.left };
}

function compareMatches(left: ParagraphMatch, right: ParagraphMatch): number {
  return (
    left.left - right.left ||
    left.right - right.right ||
    left.kind.localeCompare(right.kind) ||
    left.similarity - right.similarity
  );
}
