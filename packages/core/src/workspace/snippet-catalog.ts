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
import {
  failedResolution,
  partitionResolutions,
  type Resolution,
  type ResolutionOutcome,
} from "./resolution.js";

/** The core-owned adapter id standing in for snippet resolution, which no adapter performs. */
const SNIPPET_DIAGNOSTIC_ID = "core/snippets";

/** One resolved snippet, or the reason it could not be resolved. */
type SnippetOutcome = ResolutionOutcome<ResolvedSnippet>;

/**
 * Reads and hashes every registered snippet, reporting each one it had to drop.
 *
 * A dropped snippet is invisible in the model, and the features built on it — restoring a
 * hand-edited managed block, most of all — degrade into saying the registry never offered it.
 * That reads as a missing registration rather than an unreadable file, so every failure gets a
 * diagnostic naming the snippet and what actually went wrong.
 */
export async function resolveSnippets(
  snippets: readonly Snippet[],
  reader: FileReader,
): Promise<Resolution<ResolvedSnippet>> {
  return partitionResolutions(
    await Promise.all(snippets.map((snippet) => resolveSnippet(snippet, reader))),
  );
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

  const contents = await reader.read(path, { maxBytes: MAX_SNIPPET_BYTES });
  const read = readSnippetSource(snippet, path, contents);
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
    value: Object.freeze({
      content,
      description: snippet.description,
      hash: hashCanonicalManagedSnippet(content),
      id: snippet.id,
      name: snippet.name,
      version: snippet.version,
    }),
  };
}

/** Usable snippet text, or the one sentence saying why this read produced none. */
type SnippetSource =
  | { readonly content: string; readonly message?: undefined }
  | { readonly content?: undefined; readonly message: string };

function readSnippetSource(snippet: Snippet, path: string, source: PathContents): SnippetSource {
  if (!source.exists) {
    // Inside a compiled executable a missing snippet is a build mistake, not a broken machine:
    // the Markdown was never embedded. Say which flags embed it rather than blaming the filesystem.
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
  // A truncated snippet still parses and still hashes, so it would restore as a silently shortened
  // file. Size is only reported when a bound was requested, which is exactly this call.
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
  return failedResolution(SNIPPET_DIAGNOSTIC_ID, message, phase, path);
}
