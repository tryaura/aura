import { dirname, isAbsolute, resolve } from "node:path";

import type { AdapterSourceFile, InstructionDocument } from "@tryaura/aura-sdk";

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
