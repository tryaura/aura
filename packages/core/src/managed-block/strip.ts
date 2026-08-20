import { readManagedBlock } from "./read.js";

/**
 * Removes a legacy Aura-managed block from a source string, keeping everything else byte-for-byte.
 *
 * For a consumer deciding what a file's *user-authored* content is — instruction consolidation
 * above all — the managed block is Aura's own artifact: merging it elsewhere plants links and
 * legacy ledger sections in files that must not carry them. Unmanaged lines found inside the block
 * are user text and are kept.
 *
 * A source with no block, and one whose block does not parse, are returned unchanged: a malformed
 * block cannot be attributed to Aura with confidence, and dropping bytes on that guess would lose
 * user content.
 */
export function stripLegacyManagedBlock(source: string): string {
  const parsed = readManagedBlock(source);
  if (parsed.status !== "present") {
    return source;
  }
  return (
    source.slice(0, parsed.block.startOffset) +
    parsed.block.unmanagedContent +
    source.slice(parsed.block.endOffset)
  );
}
