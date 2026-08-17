import type { InstructionDocument, InstructionLink } from "@tryaura/aura-sdk";

import type { FileReader } from "./reader.js";

/** Fills in what only the filesystem can say about parsed instruction documents. */
export interface DocumentResolver {
  /**
   * Returns the documents with each link's `valid` and each document's `canonicalPath` replaced by
   * what the filesystem says.
   */
  readonly resolve: (
    documents: readonly InstructionDocument[],
  ) => Promise<readonly InstructionDocument[]>;
}

/**
 * Creates a resolver shared across every adapter in one scan.
 *
 * {@link Adapter.parse} is pure and cannot inspect the filesystem, so whatever it reports in
 * {@link InstructionLink.valid} is a placeholder that core overwrites here, and
 * {@link InstructionDocument.canonicalPath} is something only core can supply at all.
 *
 * Pass the scan's caching reader. Applications import the same shared instruction files, and
 * deduplicating those lookups belongs to the reader, where it also covers the paths adapters
 * declared — a target that ten documents point at is usually a file some adapter already read.
 *
 * Targets are probed, never opened. A link target is an absolute path named by an instruction file,
 * and a project document's instruction file arrives with whatever repository the user checked out.
 * `~/agents/AGENTS.md` is an ordinary thing for one to import, so the path itself cannot be
 * refused — but `valid` is all Aura reports about a target, so reading one is work this owes
 * nobody, and `~/.ssh/id_rsa` is what a hostile checkout would name instead.
 */
export function createDocumentResolver(reader: FileReader): DocumentResolver {
  const resolve = async (
    documents: readonly InstructionDocument[],
  ): Promise<readonly InstructionDocument[]> =>
    Promise.all(documents.map((document) => resolveDocument(document, reader)));

  return Object.freeze({ resolve });
}

async function resolveDocument(
  document: InstructionDocument,
  reader: FileReader,
): Promise<InstructionDocument> {
  const [canonicalPath, links] = await Promise.all([
    reader.realPath(document.path),
    Promise.all(document.links.map((link) => resolveLink(link, reader))),
  ]);

  return {
    ...document,
    ...(canonicalPath === undefined ? {} : { canonicalPath }),
    links,
  };
}

async function resolveLink(link: InstructionLink, reader: FileReader): Promise<InstructionLink> {
  return { ...link, valid: await reader.exists(link.targetPath) };
}
