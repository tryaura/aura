import { dirname, isAbsolute, resolve } from "node:path";

import type { AdapterSourceFile, InstructionDocument, InstructionLink } from "@tryaura/aura-sdk";

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
  const visible = maskCode(content);
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

/** Replaces Markdown code with spaces while preserving offsets and line boundaries. */
function maskCode(content: string): string {
  const characters = content.split("");
  let fence: "```" | "~~~" | undefined;

  for (let index = 0; index < characters.length;) {
    const marker = content.slice(index, index + 3);
    if (fence !== undefined) {
      if (marker === fence && isLineStart(content, index)) {
        fence = undefined;
      }
      index = maskUntilLineEnd(characters, content, index);
      continue;
    }
    if ((marker === "```" || marker === "~~~") && isLineStart(content, index)) {
      fence = marker;
      index = maskUntilLineEnd(characters, content, index);
      continue;
    }
    if (characters[index] === "`") {
      index = maskInlineCode(characters, content, index);
      continue;
    }
    index += 1;
  }

  return characters.join("");
}

function isLineStart(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  return content.slice(lineStart, index).trim().length === 0;
}

function maskUntilLineEnd(characters: string[], content: string, start: number): number {
  const end = content.indexOf("\n", start);
  const limit = end === -1 ? content.length : end;
  maskRange(characters, start, limit);
  return end === -1 ? content.length : end + 1;
}

function maskInlineCode(characters: string[], content: string, start: number): number {
  let ticks = 1;
  while (content[start + ticks] === "`") {
    ticks += 1;
  }
  const delimiter = "`".repeat(ticks);
  const end = content.indexOf(delimiter, start + ticks);
  const limit = end === -1 ? start + ticks : end + ticks;
  maskRange(characters, start, limit);
  return limit;
}

function maskRange(characters: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n" && characters[index] !== "\r") {
      characters[index] = " ";
    }
  }
}
