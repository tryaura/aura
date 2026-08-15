import { dirname, isAbsolute, resolve } from "node:path";

import {
  maskMarkdownCode,
  type AdapterSourceFile,
  type InstructionDocument,
  type InstructionLink,
} from "@tryaura/aura-sdk";

const IMPORT_PATTERN = /(^|[\s([{>"'])(@(?:~\/|\/)?[A-Za-z0-9_.+/-]+)/gmu;

/** References written as a path, which are imports whether or not they name a file extension. */
const PATH_PREFIX_PATTERN = /^(?:~\/|\/|\.{1,2}\/)/u;

/** A file extension on the final segment, which is what an extensionless reference lacks. */
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/u;

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
    links: parseImports(content, file.spec.path, homeDir),
    path: file.spec.path,
    scope: file.spec.scope,
    sourceId: file.spec.id,
  };
}

function parseImports(
  content: string,
  sourcePath: string,
  homeDir: string,
): readonly InstructionLink[] {
  const visible = maskMarkdownCode(content);
  const links: InstructionLink[] = [];

  for (const match of visible.matchAll(IMPORT_PATTERN)) {
    const reference = match[2]?.slice(1).replace(/[.,;:!?]+$/u, "");
    if (reference === undefined || !isImport(reference)) {
      continue;
    }
    links.push({
      kind: "import",
      targetPath: resolveImport(reference, sourcePath, homeDir),
      valid: false,
    });
  }

  return links;
}

/**
 * Whether a reference names a file rather than a person or a package.
 *
 * `@` is ordinary prose punctuation, and every false positive here becomes a link that core
 * resolves against the filesystem and then reports back to the user as a broken import. Requiring
 * either a path prefix or a file extension is what separates `@team.md` and `@~/agents/AGENTS.md`
 * from `@alice` and `@tryaura/core`.
 */
function isImport(reference: string): boolean {
  return PATH_PREFIX_PATTERN.test(reference) || FILE_EXTENSION_PATTERN.test(reference);
}

function resolveImport(reference: string, sourcePath: string, homeDir: string): string {
  if (reference.startsWith("~/")) {
    return resolve(homeDir, reference.slice(2));
  }
  if (isAbsolute(reference)) {
    return resolve(reference);
  }
  return resolve(dirname(sourcePath), reference);
}
