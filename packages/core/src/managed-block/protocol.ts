import { CONTENT_HASH_PATTERN, hashContent } from "../content-hash.js";

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
export const MANAGED_SNIPPET_HASH_PATTERN = CONTENT_HASH_PATTERN;

/** Whether an id is both line-safe and legal inside an HTML comment. */
export function isManagedSnippetId(id: string): boolean {
  return MANAGED_SNIPPET_ID_PATTERN.test(id) && !id.includes("--");
}

/**
 * Computes the protocol hash for a snippet's canonical UTF-8 contents.
 *
 * The legacy block's hash is {@link hashContent} under another name: a marked section read back
 * from an older file has to compare equal to the same text hashed anywhere else in Aura, or a
 * migration would report drift on content nobody touched.
 */
export function hashManagedSnippet(content: string): string {
  return hashContent(content);
}
