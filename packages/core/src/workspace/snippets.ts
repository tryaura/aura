import { fileURLToPath } from "node:url";

import type { ResolvedSnippet, Snippet } from "@tryaura/aura-sdk";

import {
  canonicalizeManagedSnippet,
  hashCanonicalManagedSnippet,
} from "../managed-block/protocol.js";
import { managedSnippetContentProblems } from "../managed-block/scan.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import { isEmbeddedAssetPath } from "./embedded-assets.js";
import type { FileReader, PathContents } from "./reader.js";
import { MAX_SNIPPET_BYTES } from "./reader-limits.js";

const SNIPPET_DIAGNOSTIC_ID = "core/snippets";

type SnippetOutcome =
  | { readonly diagnostic: ScanDiagnostic; readonly kind: "failed" }
  | { readonly kind: "resolved"; readonly snippet: ResolvedSnippet };

export interface ResolvedSnippets {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly snippets: readonly ResolvedSnippet[];
}

/** Reads and hashes every registered snippet, reporting each one it had to drop. */
export async function resolveSnippets(
  snippets: readonly Snippet[],
  reader: FileReader,
): Promise<ResolvedSnippets> {
  const outcomes = await Promise.all(snippets.map((snippet) => resolveSnippet(snippet, reader)));
  return Object.freeze({
    diagnostics: Object.freeze(
      outcomes.filter((outcome) => outcome.kind === "failed").map((outcome) => outcome.diagnostic),
    ),
    snippets: Object.freeze(
      outcomes.filter((outcome) => outcome.kind === "resolved").map((outcome) => outcome.snippet),
    ),
  });
}

async function resolveSnippet(snippet: Snippet, reader: FileReader): Promise<SnippetOutcome> {
  let path: string;
  try {
    path = fileURLToPath(snippet.source.url);
  } catch {
    return failedSnippet(
      `Snippet "${snippet.id}" declares a source that is not an absolute file: URL, so its content is unavailable.`,
      "files",
    );
  }

  const source = await reader.read(path, { maxBytes: MAX_SNIPPET_BYTES });
  const read = readSnippetSource(snippet, path, source);
  if (read.message !== undefined) {
    return failedSnippet(read.message, "read", path);
  }
  const content = canonicalizeManagedSnippet(read.content);
  const problem = managedSnippetContentProblems(snippet.id, content)[0];
  if (problem !== undefined) {
    return failedSnippet(problem.message, "parse", path);
  }
  return {
    kind: "resolved",
    snippet: Object.freeze({
      content,
      description: snippet.description,
      hash: hashCanonicalManagedSnippet(content),
      id: snippet.id,
      name: snippet.name,
      version: snippet.version,
    }),
  };
}

type SnippetSource =
  | { readonly content: string; readonly message?: undefined }
  | { readonly content?: undefined; readonly message: string };

function readSnippetSource(snippet: Snippet, path: string, source: PathContents): SnippetSource {
  if (!source.exists) {
    return {
      message: isEmbeddedAssetPath(path)
        ? `Snippet "${snippet.id}" was not embedded in this executable, so its content is unavailable. Compile it with the snippet Markdown as extra "bun build" entrypoints, "--loader .md:file", and "--asset-naming=content/snippets/[name].[ext]".`
        : `Snippet "${snippet.id}" points at a file that does not exist, so its content is unavailable.`,
    };
  }
  if (source.isDirectory) {
    return {
      message: `Snippet "${snippet.id}" points at a directory rather than a Markdown file, so its content is unavailable.`,
    };
  }
  if (source.problem !== undefined || source.content === undefined) {
    return {
      message: `Snippet "${snippet.id}" could not be read (${source.problem ?? "unknown"}), so its content is unavailable.`,
    };
  }
  if (source.size !== undefined && source.size > MAX_SNIPPET_BYTES) {
    return {
      message: `Snippet "${snippet.id}" is larger than the ${String(MAX_SNIPPET_BYTES)} byte snippet limit, so its content is unavailable.`,
    };
  }
  return { content: source.content };
}

function failedSnippet(
  message: string,
  phase: ScanDiagnostic["phase"],
  path?: string,
): SnippetOutcome {
  return {
    diagnostic: {
      adapterId: SNIPPET_DIAGNOSTIC_ID,
      message,
      ...(path === undefined ? {} : { path }),
      phase,
    },
    kind: "failed",
  };
}
