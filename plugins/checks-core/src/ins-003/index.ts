import {
  defineCheck,
  type DetectedFinding,
  type JsonObject,
  type Scope,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { sha256 } from "../hashing.js";
import { extractParagraphs, type InstructionParagraph } from "../instruction-paragraphs.js";
import { displayInstructionPath, instructionLineRange } from "../instruction-paths.js";
import { compareCodePoints } from "../ordering.js";
import { clusterMatches, type MatchCluster } from "./clusters.js";
import { findMatches, type ParagraphMatch } from "./matches.js";

/**
 * How many pair edges one finding carries into machine-readable output.
 *
 * A cluster holds one edge per pair of copies, so a paragraph repeated across a few hundred
 * packages produces tens of thousands of them. The members are what a consumer acts on; the edges
 * beyond this many only restate that they all match, and `matchCount` still reports the total.
 */
const METADATA_MATCH_LIMIT = 100;
/** Never appears in a path, so one file set cannot hash to the same key as another. */
const PATH_SEPARATOR = "\u0000";
/** How many copies the one-line detail names before it summarizes the rest. */
const DETAIL_LOCATION_LIMIT = 6;
/** Listed rather than derived, so cluster ordering does not depend on which scopes a run saw. */
const SCOPES: readonly Scope[] = ["global", "project"];

export const duplicateInstructionsCheck = defineCheck({
  defaultSeverity: "warn",
  detect: detectDuplicateInstructions,
  explain: `Repeated guidance across agent instruction files is easy to update in one place and forget in another. Similar copies also consume context repeatedly and can diverge into subtly different rules.

Review each reported cluster and keep its clearest version in the shared instruction source. Remove the redundant copies only after confirming their scopes and conditions are preserved.`,
  fixability: "manual",
  id: "INS-003",
  scope: "global",
  title: "Instruction guidance is not duplicated",
});

interface ClusterMember {
  readonly index: number;
  readonly paragraph: InstructionParagraph;
}

interface DescribedCluster {
  /**
   * Identity of the files involved together with the text they share.
   *
   * The files alone cannot tell two clusters apart when the same pair duplicates more than one
   * paragraph, and the ordinal that used to separate them moved whenever an unrelated duplicate
   * appeared earlier in the file — renaming a finding for an edit nowhere near it. Hashing the
   * paragraphs removes that, at a cost worth stating plainly: rewording any copy mints a new
   * identity, so a suppression written against the old one stops applying and has to be renewed.
   */
  readonly key: string;
  readonly matches: readonly ParagraphMatch[];
  readonly members: readonly ClusterMember[];
  readonly paths: readonly string[];
}

function detectDuplicateInstructions(model: WorkspaceModel): readonly DetectedFinding[] {
  const paragraphs = extractParagraphs(model.instructionFiles);
  const clusters = clusterMatches(findMatches(paragraphs))
    .flatMap((cluster) => describeCluster(cluster, paragraphs))
    .sort(compareClusters);

  return clusters.map((cluster) => findingForCluster(cluster, model));
}

/**
 * Splits one cluster into the parts INS-003 owns, which is duplication within a single scope.
 *
 * Guidance repeated from a global file into a project file is the same defect INS-008 reports as a
 * precedence problem, with the better remediation: it names which tier should keep the text. Two
 * checks describing one duplicate at two severities is noise, so the cross-tier copies are left to
 * INS-008 and every scope that still duplicates on its own is reported here.
 */
function describeCluster(
  cluster: MatchCluster,
  paragraphs: readonly InstructionParagraph[],
): readonly DescribedCluster[] {
  const members = cluster.members
    .flatMap((index) => {
      const paragraph = paragraphs[index];
      return paragraph === undefined ? [] : [{ index, paragraph }];
    })
    .sort((left, right) => compareParagraphs(left.paragraph, right.paragraph));

  return SCOPES.flatMap((scope) => {
    const scoped = members.filter((member) => member.paragraph.scope === scope);
    const paths = [...new Set(scoped.map((member) => member.paragraph.path))].sort(
      compareCodePoints,
    );
    if (paths.length < 2) {
      return [];
    }
    const indexes = new Set(scoped.map((member) => member.index));
    const matches = cluster.matches.filter(
      (match) => indexes.has(match.left) && indexes.has(match.right),
    );
    if (matches.length === 0) {
      return [];
    }
    const hashes = [...new Set(scoped.map((member) => member.paragraph.hash))].sort(
      compareCodePoints,
    );
    const key = sha256(
      `${paths.join(PATH_SEPARATOR)}${PATH_SEPARATOR}${PATH_SEPARATOR}${hashes.join(PATH_SEPARATOR)}`,
    );
    return [{ key, matches, members: scoped, paths }];
  });
}

function findingForCluster(cluster: DescribedCluster, model: WorkspaceModel): DetectedFinding {
  const memberIndexes = new Map(cluster.members.map((member, index) => [member.index, index]));
  const metadataMatches = cluster.matches
    .flatMap((match) => metadataMatch(match, memberIndexes))
    .sort(
      (left, right) =>
        left.left - right.left ||
        left.right - right.right ||
        compareCodePoints(left.kind, right.kind),
    );
  // Reduced rather than spread: `Math.min(...edges)` throws RangeError once a cluster grows past
  // roughly a hundred thousand edges, and a check that throws is a check the user stops getting.
  const similarity = metadataMatches.reduce(
    (lowest, match) => Math.min(lowest, match.similarity),
    100,
  );
  const identical = metadataMatches.every((match) => match.kind === "exact");
  const files = describeFiles(cluster.paths.map((path) => displayInstructionPath(path, model)));

  return {
    details: describeCopies(cluster.members, model),
    id: `cluster:${cluster.key}`,
    locations: cluster.members.map(({ paragraph }) => ({
      line: paragraph.startLine,
      path: paragraph.path,
    })),
    message: identical
      ? `Identical guidance appears in ${files}.`
      : `Near-identical guidance appears in ${files} (at least ${String(similarity)}% similar).`,
    metadata: {
      matchCount: metadataMatches.length,
      matches: metadataMatches.slice(0, METADATA_MATCH_LIMIT),
      members: cluster.members.map(({ paragraph }) => ({
        endLine: paragraph.endLine,
        path: paragraph.path,
        startLine: paragraph.startLine,
      })),
    },
  };
}

function describeFiles(labels: readonly string[]): string {
  const named = labels.slice(0, 2).join(", ");
  const remaining = labels.length - 2;
  return remaining > 0 ? `${named} and ${String(remaining)} more` : named;
}

/**
 * Says where every copy is, because nothing else in the report will.
 *
 * The default renderer prints a finding's message and details and nothing else, so locations that
 * only reach machine-readable output leave the user knowing a duplicate exists and not where.
 */
function describeCopies(members: readonly ClusterMember[], model: WorkspaceModel): string {
  const listed = members
    .slice(0, DETAIL_LOCATION_LIMIT)
    .map(
      ({ paragraph }) =>
        `${displayInstructionPath(paragraph.path, model)}:${instructionLineRange(paragraph.startLine, paragraph.endLine)}`,
    );
  const remaining = members.length - listed.length;
  const summary = remaining > 0 ? `, and ${String(remaining)} more` : "";
  return `Copies: ${listed.join(", ")}${summary}.`;
}

interface MetadataMatch extends JsonObject {
  readonly kind: "exact" | "near";
  readonly left: number;
  readonly right: number;
  readonly similarity: number;
}

function metadataMatch(
  match: ParagraphMatch,
  indexes: ReadonlyMap<number, number>,
): readonly MetadataMatch[] {
  const left = indexes.get(match.left);
  const right = indexes.get(match.right);
  if (left === undefined || right === undefined) {
    return [];
  }
  return [
    {
      kind: match.kind,
      left: Math.min(left, right),
      right: Math.max(left, right),
      similarity: Math.round(match.similarity * 100),
    },
  ];
}

function compareClusters(left: DescribedCluster, right: DescribedCluster): number {
  const leftFirst = left.members[0]?.paragraph;
  const rightFirst = right.members[0]?.paragraph;
  if (leftFirst !== undefined && rightFirst !== undefined) {
    const order = compareParagraphs(leftFirst, rightFirst);
    if (order !== 0) {
      return order;
    }
  }
  return compareCodePoints(left.key, right.key);
}

function compareParagraphs(left: InstructionParagraph, right: InstructionParagraph): number {
  return (
    compareCodePoints(left.path, right.path) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    compareCodePoints(left.hash, right.hash)
  );
}
