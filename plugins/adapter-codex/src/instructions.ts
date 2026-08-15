import { join } from "node:path";

import type { AdapterSourceFile, InstructionDocument } from "@tryaura/aura-sdk";

/**
 * Models Codex's file-placement mechanism as a native link to Aura's shared instructions.
 *
 * Codex has no import syntax, so placement is the only mechanism, and the link is declared
 * unconditionally. Core resolves `valid` to whether the shared file exists — nothing more. Whether
 * this document's content actually mirrors the shared instructions is a content comparison that
 * belongs to a check, not to this parser.
 */
export function parseInstructionFile(
  file: AdapterSourceFile,
  homeDir: string,
): InstructionDocument {
  return {
    content: file.content ?? "",
    links: [
      {
        kind: "native",
        targetPath: join(homeDir, "agents", "AGENTS.md"),
        valid: false,
      },
    ],
    path: file.spec.path,
    scope: file.spec.scope,
    sourceId: file.spec.id,
  };
}
