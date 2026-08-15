import type { InstructionDocument, InstructionLink } from "@tryaura/aura-sdk";

import type { FileReader } from "./reader.js";

/** Resolves the validity of instruction links, sharing one filesystem lookup per target path. */
export interface LinkResolver {
  /** Returns the documents with every link's `valid` replaced by what the filesystem says. */
  readonly resolve: (
    documents: readonly InstructionDocument[],
  ) => Promise<readonly InstructionDocument[]>;
}

/**
 * Creates a resolver shared across every adapter in one scan.
 *
 * {@link Adapter.parse} is pure and cannot inspect the filesystem, so whatever it reports in
 * {@link InstructionLink.valid} is a placeholder that core overwrites here.
 *
 * Pass the scan's caching reader. Applications import the same shared instruction files, and
 * deduplicating those lookups belongs to the reader, where it also covers the paths adapters
 * declared — a target that ten documents point at is usually a file some adapter already read.
 */
export function createLinkResolver(reader: FileReader): LinkResolver {
  const resolve = async (
    documents: readonly InstructionDocument[],
  ): Promise<readonly InstructionDocument[]> =>
    Promise.all(
      documents.map(async (document) => ({
        ...document,
        links: await Promise.all(document.links.map((link) => resolveLink(link, reader))),
      })),
    );

  return Object.freeze({ resolve });
}

async function resolveLink(link: InstructionLink, reader: FileReader): Promise<InstructionLink> {
  const contents = await reader.read(link.targetPath);
  return { ...link, valid: contents.exists };
}
