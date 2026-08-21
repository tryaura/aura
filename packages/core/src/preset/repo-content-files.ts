import { join } from "node:path";

import { parseSkillFrontmatter, type RepoSnippetEntry } from "@tryaura/aura-sdk";

import { skillIdProblem } from "../skills/path-guards.js";
import type { BoundedPathRead, FileReader } from "../workspace/reader.js";
import { MAX_SNIPPET_BYTES } from "../workspace/reader-limits.js";
import { MAX_REPO_SNIPPETS } from "./repo-content-limits.js";

/** Matches the optional frontmatter block a snippet file may open with. */
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;

/** One discovered snippet paired with the exact file text the trust hash covers. */
interface RepoSnippetFile {
  readonly entry: RepoSnippetEntry;
  /** The whole file as read — frontmatter included — which is what gets hashed. */
  readonly text: string;
}

/**
 * Why the snippet set cannot be used, or every snippet when it can.
 *
 * Problems fail the run rather than shrinking the set: these bytes are inside the trust hash and
 * may be selected after trust, so "some of the content offered for review is unreadable" must stop
 * the run the same way a broken preset does. Messages name the rule, never the offending entry.
 */
export type RepoSnippetsResult =
  | { readonly problem: string; readonly status: "invalid" }
  | { readonly files: readonly RepoSnippetFile[]; readonly status: "ready" };

/** Reads every Markdown snippet below `.aura/snippets` under the trust-set rules. */
export async function readRepoSnippets(
  root: string,
  boundary: string,
  reader: FileReader,
): Promise<RepoSnippetsResult> {
  const contents = await reader.read(root);
  if (!contents.exists) {
    return { files: [], status: "ready" };
  }
  if (contents.entries === undefined) {
    return { problem: "the snippets path is not a directory", status: "invalid" };
  }

  // Dotfiles and non-Markdown names are inert clutter (a checkout drops `.DS_Store` freely), but
  // anything named like a snippet must actually be one — a directory or symlink wearing `.md`
  // is a mistake or an escape attempt, and both fail closed below.
  const names = contents.entries.filter((entry) => !entry.startsWith(".") && entry.endsWith(".md"));
  if (names.length > MAX_REPO_SNIPPETS) {
    return {
      problem: `holds more than the ${String(MAX_REPO_SNIPPETS)} snippet limit`,
      status: "invalid",
    };
  }

  const files: RepoSnippetFile[] = [];
  for (const name of names) {
    const result = await readSnippetFile(root, name, boundary, reader);
    if (typeof result === "string") {
      return { problem: result, status: "invalid" };
    }
    files.push(result);
  }
  files.sort((left, right) => (left.entry.id < right.entry.id ? -1 : 1));
  return { files: Object.freeze(files), status: "ready" };
}

async function readSnippetFile(
  root: string,
  name: string,
  boundary: string,
  reader: FileReader,
): Promise<RepoSnippetFile | string> {
  const stem = name.slice(0, -".md".length);
  if (skillIdProblem(stem) !== undefined) {
    return "contains an entry that is not a kebab-case Markdown file name";
  }
  const read = await reader.readWithin(join(root, name), [boundary], {
    maxBytes: MAX_SNIPPET_BYTES,
  });
  const problem = snippetReadProblem(read);
  if (problem !== undefined) {
    return problem;
  }
  const text = read.contents.content ?? "";

  const frontmatter = parseSkillFrontmatter(text);
  const body = text.replace(FRONTMATTER_PATTERN, "");
  return {
    entry: Object.freeze({
      body,
      ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
      id: `repo/${stem}`,
      name: frontmatter.name ?? stem,
    }),
    text,
  };
}

/** Why a bounded, boundary-checked read did not yield a plain snippet file. */
// fallow-ignore-next-line complexity -- every branch refuses one unsafe filesystem outcome.
function snippetReadProblem(read: BoundedPathRead): string | undefined {
  if (read.kind === "outside") {
    return "contains an entry that leads outside the repository's .aura directory";
  }
  if (read.kind === "unverified" || read.contents.pathKind === "symlink") {
    return "contains an entry that is not a regular file";
  }
  const { contents } = read;
  if (
    contents.problem !== undefined ||
    contents.isDirectory ||
    contents.content === undefined ||
    contents.utf8Valid === false
  ) {
    return "contains an entry that is not a readable UTF-8 file";
  }
  if ((contents.size ?? 0) > MAX_SNIPPET_BYTES) {
    return `contains an entry larger than the ${String(MAX_SNIPPET_BYTES)} byte snippet limit`;
  }
  return undefined;
}
