import { resolve } from "node:path";

import {
  splitSourceLines,
  type InstructionDocument,
  type ResolvedSharedLink,
  type SourceLine,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { stripLegacyManagedBlock } from "@tryaura/core";

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
 * beyond a legacy block or plain import is still offered — only the text Aura planted is filtered.
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
    return (
      stripAuraInstructionArtifacts(document.content, document.path, [link]).trim().length === 0
    );
  }
  // A symlink entry is the shared file itself; the canonical-path comparison covers it.
  return false;
}

/**
 * Every content-bearing import link the workspace declares, resolved once for repeated stripping.
 *
 * {@link stripAuraInstructionArtifacts} runs per source across a whole consolidation, and each call
 * would otherwise re-walk every application to rediscover the same handful of links.
 */
export function importLineLinks(model: WorkspaceModel): readonly ResolvedSharedLink[] {
  return model.apps
    .flatMap((app) => [app.sharedLink, app.projectSharedLink])
    .filter(
      (link): link is ResolvedSharedLink =>
        link?.kind === "import-line" && link.content !== undefined,
    );
}

/** Removes legacy marked links and a plain import Aura appended at the declared entry path. */
export function stripAuraInstructionArtifacts(
  content: string,
  path: string,
  links: readonly ResolvedSharedLink[],
): string {
  const entry = resolve(path);
  let stripped = stripLegacyManagedBlock(content);
  for (const link of links) {
    if (link.content !== undefined && resolve(link.entryPath) === entry) {
      stripped = removeImportFragment(stripped, link.content);
    }
  }
  return stripped;
}

/**
 * Drops the adapter-rendered import wherever it sits, with the blank line that introduced it.
 *
 * Matched as a run of whole lines rather than as a trailing suffix: a user who adds their own
 * guidance below the import leaves it in the middle of the file, and a positional test would then
 * read Aura's own line as user text and merge it into the shared file the line points at — an
 * instruction file that imports itself. Line endings and every other byte survive untouched.
 */
function removeImportFragment(source: string, rendered: string): string {
  const wanted = rendered
    .replace(/\r\n?/gu, "\n")
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  if (wanted.every((line) => line.length === 0)) {
    return source;
  }
  const lines = [...splitSourceLines(source)];
  const start = findLineRun(lines, wanted);
  if (start === undefined) {
    return source;
  }
  // One preceding blank line goes too, because that is the seam the append itself wrote.
  const from = start > 0 && lines[start - 1]?.text.trim().length === 0 ? start - 1 : start;
  return [...lines.slice(0, from), ...lines.slice(start + wanted.length)]
    .map((line) => `${line.text}${line.ending}`)
    .join("");
}

function findLineRun(lines: readonly SourceLine[], wanted: readonly string[]): number | undefined {
  for (let start = 0; start + wanted.length <= lines.length; start += 1) {
    if (wanted.every((text, offset) => lines[start + offset]?.text.trim() === text)) {
      return start;
    }
  }
  return undefined;
}
