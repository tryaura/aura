import {
  isFileReference,
  maskMarkdownCode,
  referenceTargetPath,
  type AdapterSourceFile,
  type AtImportContext,
  type InstructionDocument,
  type InstructionLink,
  type JsonObject,
} from "@tryaura/aura-sdk";

const FILE_DIRECTIVE_PATTERN = /(^|[\s([{>"'])@file\s+([^\s)\]}>"']+)/gmu;
const REFERENCE_PATTERN = /(^|[\s([{>"'])@((?:\/|\.{1,2}\/)?[A-Za-z0-9_.+/-]+)/gmu;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const FRONTMATTER_FIELD_PATTERN = /^(alwaysApply|description|globs):\s*(.*?)\s*$/u;

export function parseRuleFile(file: AdapterSourceFile, homeDir: string): InstructionDocument {
  const content = file.content ?? "";
  const metadata = parseFrontmatter(content);
  return {
    content,
    links: parseReferences(content, { homeDir, sourcePath: file.spec.path }),
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

function parseReferences(content: string, context: AtImportContext): readonly InstructionLink[] {
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
    // Cursor's `@` mentions deliberately reach past instructions into the code they describe, so
    // any extension counts here where an instruction import would require a documented one.
    if (reference.typed || isFileReference(normalized)) {
      addReference(normalized, context, targets, links);
    }
  }

  return links;
}

function addReference(
  reference: string,
  context: AtImportContext,
  targets: Set<string>,
  links: InstructionLink[],
): void {
  if (reference.length === 0) {
    return;
  }

  const targetPath = referenceTargetPath(reference, context);
  if (targets.has(targetPath)) {
    return;
  }
  targets.add(targetPath);
  links.push({ kind: "import", targetPath, valid: false });
}

function normalizeReference(reference: string): string {
  return reference.replace(/[.,;:!?]+$/u, "");
}
