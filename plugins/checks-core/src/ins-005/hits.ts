import { resolve } from "node:path";

import { maskMarkdownCode, type InstructionDocument, type Scope } from "@tryaura/aura-sdk";

import { canonicalInstructionDocuments } from "../instruction-documents.js";
import { compareCodePoints } from "../ordering.js";
import { CONTRADICTION_AXES } from "./axes.js";

/** Words that turn a following rule into its prohibition. Matched whole, plus any `n't` contraction. */
const NEGATORS = new Set(["never", "no", "not", "without"]);
/** How many words before a match are searched for a negator. */
const NEGATION_WINDOW = 3;

export interface AxisHit {
  readonly axis: string;
  readonly line: number;
  readonly path: string;
  readonly polarity: string;
  readonly scope: Scope;
}

export interface AxisConflict {
  readonly axis: string;
  readonly left: AxisHit;
  readonly right: AxisHit;
}

/**
 * Axis evidence keyed by the document list it came from.
 *
 * Scanning applies every curated pattern to every line, and both INS-005 and INS-008 ask for the
 * hits of the same list within one run. The key is held weakly, so nothing survives the scan.
 */
const hitCache = new WeakMap<object, readonly AxisHit[]>();

/** Extracts content-free contradiction evidence from each distinct instruction path. */
export function collectAxisHits(documents: readonly InstructionDocument[]): readonly AxisHit[] {
  const cached = hitCache.get(documents);
  if (cached !== undefined) {
    return cached;
  }

  const hits = canonicalInstructionDocuments(documents)
    .flatMap((document) => hitsForDocument(document))
    .sort(compareHits);
  hitCache.set(documents, hits);
  return hits;
}

/**
 * Whether a conflict spans the global and project tiers.
 *
 * INS-005 and INS-008 both read these conflicts, so exactly one of them must own each: a conflict
 * that crosses tiers is a precedence question INS-008 answers, and one confined to a single tier is
 * the plain contradiction INS-005 reports.
 */
export function isCrossScopeConflict(conflict: AxisConflict): boolean {
  return conflict.left.scope !== conflict.right.scope;
}

/** Collapses all contradictory evidence for one axis/path pair to its first stable occurrence. */
export function findAxisConflicts(hits: readonly AxisHit[]): readonly AxisConflict[] {
  const conflicts = new Map<string, AxisConflict>();
  for (let leftIndex = 0; leftIndex < hits.length; leftIndex += 1) {
    const left = hits[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < hits.length; rightIndex += 1) {
      const right = hits[rightIndex];
      if (
        right === undefined ||
        right.axis !== left.axis ||
        right.path === left.path ||
        !polaritiesConflict(left, right)
      ) {
        continue;
      }
      const ordered =
        compareCodePoints(left.path, right.path) <= 0
          ? { left, right }
          : { left: right, right: left };
      const key = `${left.axis}\0${ordered.left.path}\0${ordered.right.path}`;
      conflicts.set(key, conflicts.get(key) ?? { axis: left.axis, ...ordered });
    }
  }
  return [...conflicts.values()].sort(compareConflicts);
}

function hitsForDocument(document: InstructionDocument): readonly AxisHit[] {
  const lines = maskMarkdownCode(document.content).split(/\r?\n/u);
  const hits: AxisHit[] = [];
  for (const [index, line] of lines.entries()) {
    for (const axis of CONTRADICTION_AXES) {
      for (const pattern of axis.patterns) {
        for (const match of line.matchAll(pattern.regex)) {
          if (isNegated(line, match.index)) {
            continue;
          }
          hits.push({
            axis: axis.id,
            line: index + 1,
            path: resolve(document.path),
            polarity: resolvePolarity(pattern.polarity, match),
            scope: document.scope,
          });
        }
      }
    }
  }
  return hits;
}

/**
 * Whether the words just before a match turn the rule it states into a prohibition.
 *
 * The patterns recognize a stance, not a sentence, so "do not ever use npm" matches "use npm" as
 * readily as an endorsement does. Dropping the hit rather than inverting it is deliberate: what
 * the author forbade is known, what they meant instead is not, and a finding that quotes a file as
 * saying the opposite of what it says costs more than a contradiction left unreported.
 */
function isNegated(line: string, matchIndex: number): boolean {
  const preceding = line
    .slice(0, matchIndex)
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length > 0)
    .slice(-NEGATION_WINDOW);
  return preceding.some((word) => NEGATORS.has(word) || word.endsWith("n't"));
}

function resolvePolarity(template: string, match: RegExpMatchArray): string {
  return template
    .replace(/\$(\d+)/gu, (_placeholder, rawIndex: string) => {
      const index = Number(rawIndex);
      return match[index]?.toLocaleLowerCase("en-US") ?? "";
    })
    .toLocaleLowerCase("en-US");
}

function polaritiesConflict(left: AxisHit, right: AxisHit): boolean {
  if (left.polarity === right.polarity) {
    return false;
  }
  if (left.axis !== "indentation") {
    return true;
  }
  const leftSpaces = left.polarity.startsWith("spaces:");
  const rightSpaces = right.polarity.startsWith("spaces:");
  if (!leftSpaces || !rightSpaces) {
    return true;
  }
  return left.polarity !== "spaces:any" && right.polarity !== "spaces:any";
}

function compareHits(left: AxisHit, right: AxisHit): number {
  return (
    compareCodePoints(left.axis, right.axis) ||
    compareCodePoints(left.path, right.path) ||
    left.line - right.line ||
    compareCodePoints(left.polarity, right.polarity)
  );
}

function compareConflicts(left: AxisConflict, right: AxisConflict): number {
  return (
    compareCodePoints(left.axis, right.axis) ||
    compareCodePoints(left.left.path, right.left.path) ||
    compareCodePoints(left.right.path, right.right.path)
  );
}
