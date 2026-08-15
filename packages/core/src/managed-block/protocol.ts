import { createHash } from "node:crypto";

/** Distribution-independent outer marker opening Aura-managed content. */
export const AURA_MANAGED_BLOCK_BEGIN = "<!-- aura:begin -->";

/** Distribution-independent outer marker closing Aura-managed content. */
export const AURA_MANAGED_BLOCK_END = "<!-- aura:end -->";

/** Prefix shared by every Aura snippet opening marker. */
export const AURA_MANAGED_SNIPPET_BEGIN_PREFIX = "<!-- aura:begin id=";

/** Prefix shared by every Aura snippet closing marker. */
export const AURA_MANAGED_SNIPPET_END_PREFIX = "<!-- aura:end id=";

/** Human-facing ownership warning rendered once inside the outer block. */
export const AURA_MANAGED_BLOCK_NOTICE =
  "Managed by Aura. Edit via the Aura CLI; manual edits to this block are overwritten.";

const MANAGED_SNIPPET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const MANAGED_SNIPPET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Whether an id is both line-safe and legal inside an HTML comment. */
export function isManagedSnippetId(id: string): boolean {
  return MANAGED_SNIPPET_ID_PATTERN.test(id) && !id.includes("--");
}

/**
 * Normalizes snippet text to the bytes covered by the managed-block hash protocol.
 *
 * Trailing newlines are trimmed by scanning rather than with `/\n+$/`, whose backtracking is
 * quadratic when a long newline run does not reach the end of the string.
 */
export function canonicalizeManagedSnippet(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "\n") {
    end -= 1;
  }
  return `${normalized.slice(0, end)}\n`;
}

/** Computes the protocol hash for text already in {@link canonicalizeManagedSnippet} form. */
export function hashCanonicalManagedSnippet(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Computes the protocol hash for a snippet's canonical UTF-8 contents. */
export function hashManagedSnippet(content: string): string {
  return hashCanonicalManagedSnippet(canonicalizeManagedSnippet(content));
}
