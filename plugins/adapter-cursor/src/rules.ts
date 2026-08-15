import { dirname, isAbsolute, resolve } from "node:path";

import {
  maskMarkdownCode,
  type AdapterSourceFile,
  type InstructionDocument,
  type InstructionLink,
  type JsonObject,
} from "@tryaura/aura-sdk";

const FILE_DIRECTIVE_PATTERN = /(^|[\s([{>"'])@file\s+([^\s)\]}>"']+)/gmu;
const REFERENCE_PATTERN = /(^|[\s([{>"'])@((?:\/|\.{1,2}\/)?[A-Za-z0-9_.+/-]+)/gmu;
const PATH_PREFIX_PATTERN = /^(?:\/|\.{1,2}\/)/u;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]+$/u;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const FRONTMATTER_FIELD_PATTERN = /^(alwaysApply|description|globs):\s*(.*?)\s*$/u;

export function parseRuleFile(file: AdapterSourceFile): InstructionDocument {
  const content = file.content ?? "";
  const metadata = parseFrontmatter(content);
  return {
    content,
    links: parseReferences(content, file.spec.path),
    ...(metadata === undefined ? {} : { metadata }),
    path: file.spec.path,
    scope: file.spec.scope,
    sourceId: file.spec.id,
  };
}

/**
 * Reads the activation fields Cursor defines for `.mdc` frontmatter.
 *
 * `alwaysApply`, `description`, and `globs` decide when Cursor attaches a rule, so anything
 * reasoning about which instructions are active needs them surfaced. Parsing is deliberately
 * narrow: the three documented keys as flat `key: value` lines, which is the only shape Cursor
 * writes. The block itself stays part of {@link InstructionDocument.content}, which holds the
 * full file.
 */
function parseFrontmatter(content: string): JsonObject | undefined {
  const block = FRONTMATTER_PATTERN.exec(content)?.[1];
  if (block === undefined) {
    return undefined;
  }

  const fields = block.split(/\r?\n/u).flatMap(parseFrontmatterField);
  return fields.length === 0 ? undefined : Object.fromEntries(fields);
}

function parseFrontmatterField(line: string): readonly (readonly [string, string | boolean])[] {
  const match = FRONTMATTER_FIELD_PATTERN.exec(line);
  const name = match?.[1];
  const value = match?.[2];
  if (name === undefined || value === undefined || value.length === 0) {
    return [];
  }
  return [[name, name === "alwaysApply" ? value === "true" : value]];
}

function parseReferences(content: string, sourcePath: string): readonly InstructionLink[] {
  const visible = maskMarkdownCode(content);
  const links: InstructionLink[] = [];
  const targets = new Set<string>();
  const references: { readonly index: number; readonly raw: string; readonly typed: boolean }[] =
    [];

  for (const match of visible.matchAll(FILE_DIRECTIVE_PATTERN)) {
    const raw = match[2];
    if (raw !== undefined) {
      references.push({ index: match.index, raw, typed: true });
    }
  }
  for (const match of visible.matchAll(REFERENCE_PATTERN)) {
    const raw = match[2];
    if (raw !== undefined && raw !== "file") {
      references.push({ index: match.index, raw, typed: false });
    }
  }
  references.sort((left, right) => left.index - right.index);
  for (const reference of references) {
    const normalized = normalizeReference(reference.raw);
    if (reference.typed || isReference(normalized)) {
      addReference(normalized, sourcePath, targets, links);
    }
  }

  return links;
}

function addReference(
  reference: string,
  sourcePath: string,
  targets: Set<string>,
  links: InstructionLink[],
): void {
  if (reference.length === 0) {
    return;
  }

  const targetPath = isAbsolute(reference)
    ? resolve(reference)
    : resolve(dirname(sourcePath), reference);
  if (targets.has(targetPath)) {
    return;
  }
  targets.add(targetPath);
  links.push({ kind: "import", targetPath, valid: false });
}

function normalizeReference(reference: string): string {
  return reference.replace(/[.,;:!?]+$/u, "");
}

function isReference(reference: string): boolean {
  return PATH_PREFIX_PATTERN.test(reference) || FILE_EXTENSION_PATTERN.test(reference);
}
