import {
  parseAtImports,
  type AdapterSourceFile,
  type InstructionDocument,
} from "@tryaura/aura-sdk";

/**
 * Parses one instruction document.
 *
 * `homeDir` is passed in rather than inferred from `file`: `~/` imports need it, and a document's
 * own path says nothing reliable about where home is.
 */
export function parseInstructionFile(
  file: AdapterSourceFile,
  homeDir: string,
): InstructionDocument {
  const content = file.content ?? "";
  return {
    content,
    links: parseAtImports(content, { homeDir, sourcePath: file.spec.path }),
    path: file.spec.path,
    scope: file.spec.scope,
    sourceId: file.spec.id,
  };
}
