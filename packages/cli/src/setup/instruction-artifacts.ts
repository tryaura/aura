import { resolve } from "node:path";

import type { InstructionDocument, ResolvedSharedLink, WorkspaceModel } from "@tryaura/aura-sdk";
import { stripManagedBlock } from "@tryaura/core";

/**
 * The physical file a document names, for comparisons that must see through symbolic links.
 *
 * The Codex shared link is a symlink at `~/.codex/AGENTS.md` pointing at the consolidation target
 * itself; compared by `path` alone it reads as an independent instruction file whose content is
 * the target's own, and consolidating it merges the target into itself. Falls back to `path` when
 * nothing resolved, such as a dangling link.
 */
export function canonicalSourcePath(document: InstructionDocument): string {
  return resolve(document.canonicalPath ?? document.path);
}

/**
 * Whether this document is one of Aura's own link artifacts rather than user guidance.
 *
 * Recognized intrinsically, from the document matching an adapter's declared shared-link shape at
 * its declared entry path, because the manifest's ownership ledger is the usual guard and the one
 * record a damaged or trust-only manifest is missing. An entry file that also carries user text
 * beyond the managed block is still offered — only the text Aura itself planted is filtered.
 */
export function isAuraArtifact(document: InstructionDocument, model: WorkspaceModel): boolean {
  const path = resolve(document.path);
  return model.apps.some((app) =>
    [app.sharedLink, app.projectSharedLink].some(
      (link) =>
        link !== undefined && resolve(link.entryPath) === path && matchesLink(document, link),
    ),
  );
}

function matchesLink(document: InstructionDocument, link: ResolvedSharedLink): boolean {
  if (link.kind === "native-copy") {
    return document.content === link.content;
  }
  if (link.kind === "import-line") {
    return stripManagedBlock(document.content).trim().length === 0;
  }
  // A symlink entry is the shared file itself; the canonical-path comparison covers it.
  return false;
}
