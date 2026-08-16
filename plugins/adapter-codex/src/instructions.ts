import { dirname, isAbsolute, resolve } from "node:path";

import type { AdapterFileMap, AdapterSourceFile, InstructionDocument } from "@tryaura/aura-sdk";

/** What one level's candidates resolved to: the file Codex reads, and the ones it does not. */
export interface SelectedInstructions {
  readonly documents: readonly InstructionDocument[];
  /** Files present on disk that a higher-priority file at the same level shadows. */
  readonly shadowed: readonly AdapterSourceFile[];
}

/**
 * Picks the instruction file Codex loads from each directory it reads, in Codex's own order.
 *
 * Codex takes at most one file per level: `AGENTS.override.md` when that level has one, and
 * `AGENTS.md` otherwise. Modelling both would report guidance that is sitting on disk but shadowed,
 * so the loser is dropped here rather than left for a check to rediscover — and named in
 * {@link SelectedInstructions.shadowed}, because a file the user can see and Aura ignored is
 * exactly the kind of silence this tool exists to break. An empty file is not a file at that level,
 * which is why the first *non-empty* candidate wins, with the first readable one kept as a floor so
 * a broken symlink still reaches INS-002.
 *
 * Levels arrive in declaration order, which {@link codexFiles} fixes as global first, then the
 * repository root down to the invocation directory — the order Codex concatenates them in.
 */
export function selectInstructionFiles(files: AdapterFileMap): SelectedInstructions {
  const levels = new Map<string, AdapterSourceFile[]>();

  for (const file of files.values()) {
    if (file.spec.kind !== "instructions" || !isReadableInstructionSource(file)) {
      continue;
    }
    const level = dirname(resolve(file.spec.path));
    const candidates = levels.get(level);
    if (candidates === undefined) {
      levels.set(level, [file]);
      continue;
    }
    candidates.push(file);
  }

  const documents: InstructionDocument[] = [];
  const shadowed: AdapterSourceFile[] = [];
  for (const candidates of levels.values()) {
    const chosen =
      candidates.find((file) => (file.content ?? "").trim().length > 0) ?? candidates[0];
    if (chosen === undefined) {
      continue;
    }

    documents.push(parseInstructionFile(chosen));
    shadowed.push(...candidates.filter((file) => file !== chosen));
  }

  return { documents, shadowed };
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
export function parseInstructionFile(file: AdapterSourceFile): InstructionDocument {
  const target = file.symlinkTarget;
  return {
    content: file.content ?? "",
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
