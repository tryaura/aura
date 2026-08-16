import { extname, resolve } from "node:path";

import { maskMarkdownCode, type InstructionDocument, type Scope } from "@tryaura/aura-sdk";

import { sha256 } from "./hashing.js";
import { canonicalInstructionDocuments } from "./instruction-documents.js";

const MINIMUM_PARAGRAPH_LENGTH = 40;
/** Never appears in prose, so joined parts cannot collide with a value that contains it. */
const CODE_SEPARATOR = "\u0000";

const LIST_MARKER_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/u;
const TRAILING_PUNCTUATION_PATTERN = /\p{P}+$/u;
const TABLE_DIVIDER_PATTERN = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/u;
const LICENSE_START_PATTERN =
  /^(?:<!--\s*)?(?:[#>*-]\s*)*(?:copyright\b|©|spdx-license-identifier\s*:|licensed under\b|permission is hereby granted\b|all rights reserved\b)/iu;

export interface InstructionParagraph {
  /**
   * Signature of the code the paragraph embeds, separate from {@link InstructionParagraph.hash}.
   *
   * Code is masked before normalization, so "run `pnpm lint`" and "run `pnpm publish --force`"
   * normalize to the same prose. Those are different instructions, and telling the user to
   * consolidate them would delete the distinction, so what was masked is kept for comparison.
   */
  readonly code: string;
  readonly conditional: boolean;
  readonly endLine: number;
  /** Covers the normalized prose and {@link InstructionParagraph.code} together. */
  readonly hash: string;
  readonly normalized: string;
  readonly path: string;
  readonly scope: Scope;
  readonly startLine: number;
}

/**
 * Segmentation results keyed by the document list they came from.
 *
 * Checks are pure and every check in a run receives the same workspace model, so more than one
 * check asking for the paragraphs of the same list must not re-segment every instruction file.
 * The key is held weakly, so nothing survives the scan that produced it.
 */
const paragraphCache = new WeakMap<object, readonly InstructionParagraph[]>();

/** Extracts deterministic, prose-like paragraphs from each distinct instruction path. */
export function extractParagraphs(
  documents: readonly InstructionDocument[],
): readonly InstructionParagraph[] {
  const cached = paragraphCache.get(documents);
  if (cached !== undefined) {
    return cached;
  }

  const paragraphs = canonicalInstructionDocuments(documents)
    .flatMap(segmentDocument)
    .sort(compareParagraphs);
  paragraphCache.set(documents, paragraphs);
  return paragraphs;
}

/** Groups extracted paragraphs by exact content hash, for checks that compare identical guidance. */
export function paragraphHashBuckets(
  paragraphs: readonly InstructionParagraph[],
): ReadonlyMap<string, readonly number[]> {
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

export function normalizeParagraph(lines: readonly string[]): string {
  return lines
    .map((line) => line.replace(LIST_MARKER_PATTERN, ""))
    .join(" ")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(TRAILING_PUNCTUATION_PATTERN, "")
    .trim();
}

function segmentDocument(document: InstructionDocument): readonly InstructionParagraph[] {
  const path = resolve(document.path);
  const lines = maskMarkdownCode(document.content).split(/\r?\n/u);
  const rawLines = document.content.split(/\r?\n/u);
  const paragraphs: InstructionParagraph[] = [];
  let startLine: number | undefined;
  let paragraphLines: string[] = [];
  let paragraphCode: string[] = [];

  const finishParagraph = (endLine: number): void => {
    if (startLine === undefined) {
      return;
    }
    const normalized = normalizeParagraph(paragraphLines);
    if (
      normalized.length >= MINIMUM_PARAGRAPH_LENGTH &&
      !isMarkdownTable(paragraphLines) &&
      !isLicenseBoilerplate(paragraphLines) &&
      !isFrontmatter(paragraphLines)
    ) {
      const code = paragraphCode.join(CODE_SEPARATOR);
      paragraphs.push({
        code,
        conditional: isConditionalRule(document),
        endLine,
        hash: sha256(`${normalized}${CODE_SEPARATOR}${code}`),
        normalized,
        path,
        scope: document.scope,
        startLine,
      });
    }
    startLine = undefined;
    paragraphLines = [];
    paragraphCode = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      finishParagraph(index);
      continue;
    }
    startLine ??= index + 1;
    paragraphLines.push(line);
    paragraphCode.push(codeSignature(rawLines[index] ?? "", line));
  }
  finishParagraph(lines.length);

  return paragraphs;
}

/**
 * Recovers what {@link maskMarkdownCode} blanked out on one line, as a comparable signature.
 *
 * Masking preserves offsets, so a position the mask turned into a space while the source held
 * something else is code. Runs are kept apart rather than concatenated, so `pnpm publish --force`
 * cannot collapse into a neighbouring token and read as identical to `pnpm lint`.
 */
function codeSignature(raw: string, masked: string): string {
  const runs: string[] = [];
  let current = "";

  for (let index = 0; index < masked.length; index += 1) {
    const source = raw[index] ?? "";
    if (masked[index] === " " && source !== " " && source.length > 0) {
      current += source;
      continue;
    }
    if (current.length > 0) {
      runs.push(current);
      current = "";
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }

  return runs.join(CODE_SEPARATOR);
}

function isMarkdownTable(lines: readonly string[]): boolean {
  const visible = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  return (
    visible.length >= 2 &&
    visible.every((line) => line.includes("|") || TABLE_DIVIDER_PATTERN.test(line))
  );
}

function isLicenseBoilerplate(lines: readonly string[]): boolean {
  return LICENSE_START_PATTERN.test(lines.join(" ").trim());
}

function isFrontmatter(lines: readonly string[]): boolean {
  return lines.length >= 2 && lines[0]?.trim() === "---" && lines.at(-1)?.trim() === "---";
}

function isConditionalRule(document: InstructionDocument): boolean {
  return (
    extname(document.path).toLowerCase() === ".mdc" && document.metadata?.["alwaysApply"] === false
  );
}

function compareParagraphs(left: InstructionParagraph, right: InstructionParagraph): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) {
    return pathOrder;
  }
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }
  if (left.endLine !== right.endLine) {
    return left.endLine - right.endLine;
  }
  return left.hash.localeCompare(right.hash);
}
