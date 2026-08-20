import { createHash } from "node:crypto";

/** Shape of every hash this module produces, for validators that must recognize one. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Normalizes Markdown to LF and exactly one trailing newline.
 *
 * Line endings and trailing blank lines are what a checkout, an editor, or an append seam change
 * without changing what the text says, so a hash that counted them would report drift on every
 * machine that rewrote them — and a fragment appended in this form is the same text the hash
 * covers. Trailing newlines are trimmed by scanning rather than with `/\n+$/`, whose backtracking
 * is quadratic when a long newline run does not reach the end of the string.
 */
export function canonicalizeContent(content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n");
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "\n") {
    end -= 1;
  }
  return `${normalized.slice(0, end)}\n`;
}

/**
 * Fingerprints Markdown Aura records but does not own: an installed snippet, a trusted preset.
 *
 * One function for both because the two records answer the same question — "is this still the text
 * the user accepted?" — and two spellings of the canonical form would answer it differently on the
 * first file whose line endings a checkout rewrote.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(canonicalizeContent(content), "utf8").digest("hex");
}
