import { dirname, isAbsolute, resolve } from "node:path";
import { Buffer } from "node:buffer";

import type { AdapterFileMap, AdapterSourceFile, InstructionDocument } from "@tryaura/aura-sdk";

/** What one level's candidates resolved to: the file Codex reads, and the ones it does not. */
export interface SelectedInstructions {
  readonly documents: readonly InstructionDocument[];
  /** Files present on disk that a higher-priority file at the same level shadows. */
  readonly shadowed: readonly AdapterSourceFile[];
}

export interface InstructionSelectionOptions {
  readonly projectMaxBytes: number;
}

/**
 * Picks the instruction file Codex loads from each directory it reads, in Codex's own order.
 *
 * Project discovery has already selected the first existing candidate before this function runs.
 * If a caller supplies several project candidates directly, declaration order therefore wins even
 * when the first file is empty: Codex skips that empty document without falling back. Global scope
 * is different and keeps Codex's first-non-empty rule. Losers are named in
 * {@link SelectedInstructions.shadowed}, because a file the user can see and Aura ignored is
 * exactly the kind of silence this tool exists to break.
 *
 * Levels arrive in declaration order, which {@link codexFiles} fixes as global first, then the
 * repository root down to the invocation directory — the order Codex concatenates them in.
 */
export function selectInstructionFiles(
  files: AdapterFileMap,
  options: InstructionSelectionOptions,
): SelectedInstructions {
  const documents: InstructionDocument[] = [];
  const shadowed: AdapterSourceFile[] = [];
  let projectBytesRemaining = options.projectMaxBytes;
  for (const candidates of instructionLevels(files).values()) {
    const chosen = selectedCandidate(candidates);
    if (chosen === undefined) {
      continue;
    }

    shadowed.push(...candidates.filter((file) => file !== chosen));
    if (chosen.spec.scope === "project") {
      const selected = projectDocument(chosen, projectBytesRemaining);
      if (selected === undefined) {
        continue;
      }
      documents.push(selected.document);
      projectBytesRemaining -= selected.bytes;
      continue;
    }

    documents.push(parseInstructionFile(chosen));
  }

  return { documents, shadowed };
}

function instructionLevels(files: AdapterFileMap): ReadonlyMap<string, AdapterSourceFile[]> {
  const levels = new Map<string, AdapterSourceFile[]>();
  for (const file of files.values()) {
    if (file.spec.kind !== "instructions" || !isReadableInstructionSource(file)) {
      continue;
    }
    const level = dirname(resolve(file.spec.path));
    const candidates = levels.get(level);
    if (candidates === undefined) {
      levels.set(level, [file]);
    } else {
      candidates.push(file);
    }
  }
  return levels;
}

function selectedCandidate(
  candidates: readonly AdapterSourceFile[],
): AdapterSourceFile | undefined {
  const first = candidates[0];
  if (first?.spec.scope === "project") {
    return first;
  }
  return candidates.find(hasContent) ?? first;
}

function hasContent(file: AdapterSourceFile): boolean {
  return (file.content ?? "").trim().length > 0;
}

function projectDocument(
  file: AdapterSourceFile,
  remaining: number,
): { readonly bytes: number; readonly document: InstructionDocument } | undefined {
  if (remaining === 0) {
    return undefined;
  }

  const source = projectContent(file, remaining);
  if (!hasProjectContent(file, source.content)) {
    return undefined;
  }

  return {
    bytes: Math.min(source.sourceBytes, remaining),
    document: parseInstructionFile(file, source.content),
  };
}

function projectContent(
  file: AdapterSourceFile,
  remaining: number,
): { readonly content: string; readonly sourceBytes: number } {
  const content = file.content ?? "";
  const original = Buffer.from(content, "utf8");
  const sourceBytes = file.size ?? original.length;
  if (sourceBytes <= remaining || file.spec.maxBytes === remaining) {
    return { content, sourceBytes };
  }

  return { content: original.subarray(0, remaining).toString("utf8"), sourceBytes };
}

function hasProjectContent(file: AdapterSourceFile, content: string): boolean {
  if (content.trim().length > 0) {
    return true;
  }

  return file.pathKind === "symlink" && file.symlinkTarget !== undefined;
}

/**
 * Whether core came back with something an adapter may describe as an instruction file.
 *
 * A path core refused to read — denied, oversized, outside the project — is not an empty
 * instruction file, and modelling it as one asserts the user wrote nothing where nobody looked. A
 * directory is the same claim by a different route: `AGENTS.md` naming a folder holds no guidance,
 * and a repository is free to ship one. A dangling symlink is the deliberate exception: it carries
 * no `problem` and no contents, and the broken link itself is the thing INS-002 needs to see.
 */
function isReadableInstructionSource(file: AdapterSourceFile): boolean {
  if (!file.exists || file.problem !== undefined) {
    return false;
  }

  return file.content !== undefined || (file.pathKind === "symlink" && file.entries === undefined);
}

/**
 * Models a real Codex instruction symlink without mistaking a user-owned file for one.
 *
 * Codex has no import syntax, so a regular `AGENTS.md` carries no link. Core resolves a symbolic
 * link's validity from its actual target, while INS-002 decides whether that target is Aura's shared
 * instruction source.
 */
export function parseInstructionFile(
  file: AdapterSourceFile,
  content = file.content ?? "",
): InstructionDocument {
  const target = file.symlinkTarget;
  return {
    content,
    links:
      file.pathKind === "symlink" && target !== undefined
        ? [
            {
              kind: "symlink",
              targetPath: isAbsolute(target)
                ? resolve(target)
                : resolve(dirname(file.spec.path), target),
              valid: false,
            },
          ]
        : [],
    path: file.spec.path,
    scope: file.spec.scope,
    sourceId: file.spec.id,
  };
}
