import { dirname, isAbsolute, resolve } from "node:path";

import { maskMarkdownCode } from "./markdown.js";
import type { InstructionLink } from "./model.js";

const IMPORT_PATTERN = /(^|[\s([{>"'])(@(?:~\/|\/)?[A-Za-z0-9_.+/-]+)/gmu;

/** Prose punctuation that ends a sentence rather than the path inside it. */
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/u;

/** References written as a path, which are references whether or not they name a file extension. */
const PATH_PREFIX_PATTERN = /^(?:~\/|\/|\.{1,2}\/)/u;

/** A file extension on the final segment, which is what an extensionless reference lacks. */
const FILE_EXTENSION_PATTERN = /\.([A-Za-z0-9]+)$/u;

/**
 * Extensions an application will have written its instructions in.
 *
 * A bare `@name.ext` is the ambiguous form: unlike `@./name.ext` it carries no evidence that the
 * author meant a path at all, and `@example.com`, `@v1.2`, and `@Jan.Kowalski` all reach this
 * point looking exactly like one. Restricting the extension is what separates them from `@team.md`
 * without also rejecting the `@../shared/rules` a path prefix already vouches for.
 */
const INSTRUCTION_EXTENSIONS: ReadonlySet<string> = new Set([
  "markdown",
  "md",
  "mdc",
  "mdx",
  "txt",
]);

/** What one `@` reference needs to resolve against. */
export interface AtImportContext {
  /** The current user's home directory, which `~/` references resolve against. */
  readonly homeDir: string;
  /** Absolute path of the document declaring the reference. */
  readonly sourcePath: string;
}

/**
 * Collects the `@` imports a document declares, one link per distinct target.
 *
 * Code spans and fences are masked first, so a reference shown as an example stays an example.
 * Targets are deduplicated because the link count is otherwise bounded only by file size, and a
 * project instruction file is one the user did not write — it arrives with the repository. Two
 * mentions of one path are also nothing a user needs told twice.
 *
 * `homeDir` is passed in rather than inferred: `~/` imports need it, and a document's own path
 * says nothing reliable about where home is.
 */
export function parseAtImports(
  content: string,
  context: AtImportContext,
): readonly InstructionLink[] {
  const visible = maskMarkdownCode(content);
  const links: InstructionLink[] = [];
  const targets = new Set<string>();

  for (const match of visible.matchAll(IMPORT_PATTERN)) {
    const reference = match[2]?.slice(1).replace(TRAILING_PUNCTUATION_PATTERN, "");
    if (reference === undefined || !isInstructionReference(reference)) {
      continue;
    }

    const targetPath = referenceTargetPath(reference, context);
    if (targets.has(targetPath)) {
      continue;
    }
    targets.add(targetPath);
    links.push({ kind: "import", targetPath, valid: false });
  }

  return links;
}

/**
 * Whether a reference names an instruction file rather than a person, a package, or a version.
 *
 * `@` is ordinary prose punctuation, and every false positive here becomes a link that core
 * resolves against the filesystem and a check then reports back as a broken import. Requiring
 * either a path prefix or an instruction file extension is what separates `@team.md` and
 * `@~/agents/AGENTS.md` from `@alice`, `@tryaura/core`, and `@v1.2`.
 */
export function isInstructionReference(reference: string): boolean {
  const extension = FILE_EXTENSION_PATTERN.exec(reference)?.[1];
  return (
    PATH_PREFIX_PATTERN.test(reference) ||
    (extension !== undefined && INSTRUCTION_EXTENSIONS.has(extension.toLowerCase()))
  );
}

/**
 * Whether a reference names a file of any kind.
 *
 * For applications whose `@` mentions deliberately reach past instructions into the code they
 * describe. Looser than {@link isInstructionReference} by exactly one rule: any extension counts.
 */
export function isFileReference(reference: string): boolean {
  return PATH_PREFIX_PATTERN.test(reference) || FILE_EXTENSION_PATTERN.test(reference);
}

/** Resolves one reference to the absolute path it names. */
export function referenceTargetPath(reference: string, context: AtImportContext): string {
  if (reference.startsWith("~/")) {
    return resolve(context.homeDir, reference.slice(2));
  }
  if (isAbsolute(reference)) {
    return resolve(reference);
  }
  return resolve(dirname(context.sourcePath), reference);
}
