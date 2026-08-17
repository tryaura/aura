import { fileURLToPath } from "node:url";

import type {
  Adapter,
  AppModel,
  Environment,
  ResolvedSnippet,
  Snippet,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { auraManifestDiagnostics } from "../manifest/diagnostic.js";
import { resolveAuraManifestPath } from "../manifest/protocol.js";
import { readAuraManifest } from "../manifest/read.js";
import {
  canonicalizeManagedSnippet,
  hashCanonicalManagedSnippet,
} from "../managed-block/protocol.js";
import { managedSnippetContentProblems } from "../managed-block/scan.js";
import { type ScanContext, scanAdapter, type SkippedApp } from "./adapter-scan.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import { createDocumentResolver } from "./documents.js";
import { findProjectRoot } from "./project-root.js";
import {
  createCachingReader,
  createFileReader,
  type FileReader,
  type PathContents,
} from "./reader.js";
import { MAX_SNIPPET_BYTES } from "./reader-limits.js";
import { scanRepository } from "./repository.js";
import { sharedInstructionsPath, toSharedInstructions } from "./shared-links.js";

export type { SkippedApp } from "./adapter-scan.js";

/** Everything {@link buildWorkspaceModel} needs. */
export interface WorkspaceScanOptions {
  /**
   * The adapters to run, in the order their results should appear.
   *
   * A plain list rather than a registry: validating plugins is a separate concern, and the builder
   * is just as usable from a test with one fake adapter as from the assembled CLI.
   */
  readonly adapters: readonly Adapter[];
  /** Ambient state captured at boot. */
  readonly environment: Environment;
  /** Filesystem access. Defaults to the real one. */
  readonly reader?: FileReader | undefined;
  /**
   * Registry snippets to resolve during the same read pass, each bounded by
   * {@link MAX_SNIPPET_BYTES}. A snippet that cannot be resolved is reported as a diagnostic and
   * left out of the model rather than surfaced as a partial one.
   */
  readonly snippets?: readonly Snippet[] | undefined;
}

/** The outcome of one scan: what the machine looks like, and what went wrong while looking. */
export interface WorkspaceScan {
  /** Problems with the scan itself. Empty on a clean run. */
  readonly diagnostics: readonly ScanDiagnostic[];
  /** The normalized machine state every check runs against. */
  readonly model: WorkspaceModel;
  /**
   * Applications that were looked for and not found.
   *
   * Not a problem, and not worth reporting by default — most machines have most applications
   * missing. Recording it anyway is what lets a report answer "why didn't you check X?", which it
   * cannot do if an absent application leaves no trace at all.
   */
  readonly skipped: readonly SkippedApp[];
}

/**
 * Runs every adapter's lifecycle and assembles the normalized workspace model.
 *
 * This is the kernel's single read pass: adapters detect their application, declare the paths that
 * matter, core reads them once, and each adapter parses its own contents. Everything Aura knows
 * about the machine comes out of here, so checks can be pure functions that never touch disk.
 *
 * Adapters run concurrently, but results keep the declared adapter order so that two runs over an
 * unchanged machine produce identical output.
 */
export async function buildWorkspaceModel(options: WorkspaceScanOptions): Promise<WorkspaceScan> {
  const reader = createCachingReader(options.reader ?? createFileReader());
  const projectRoot = findProjectRoot(options.environment.cwd, reader);
  const context: ScanContext = {
    documents: createDocumentResolver(reader),
    environment: options.environment,
    projectBoundary: resolveProjectBoundary(projectRoot, options.environment.cwd, reader),
    projectRoot,
    reader,
  };
  const sharedPath = sharedInstructionsPath(options.environment);
  const manifestPath = resolveAuraManifestPath(options.environment.homeDir);

  // The repository scan needs only the project root, so it runs alongside the adapters rather than
  // after them: its Git probes are latency the scan would otherwise pay end to end.
  const [scans, root, repository, sharedContents, manifestContents, resolvedSnippets] =
    await Promise.all([
      Promise.all(options.adapters.map((adapter) => scanAdapter(adapter, context))),
      projectRoot,
      projectRoot.then((found) =>
        found === undefined ? undefined : scanRepository(found, options.environment, reader),
      ),
      reader.read(sharedPath),
      reader.read(manifestPath),
      resolveSnippets(options.snippets ?? [], reader),
    ]);

  const apps: AppModel[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  const skipped: SkippedApp[] = [];
  for (const scan of scans) {
    if (scan.app !== undefined) {
      apps.push(scan.app);
    }
    if (scan.skipped !== undefined) {
      skipped.push(scan.skipped);
    }
    diagnostics.push(...scan.diagnostics);
  }

  const manifest = readAuraManifest(manifestPath, manifestContents);
  diagnostics.push(...auraManifestDiagnostics(manifest));
  diagnostics.push(...resolvedSnippets.diagnostics);

  return {
    diagnostics,
    model: {
      availableSnippets: resolvedSnippets.snippets,
      apps,
      cwd: options.environment.cwd,
      homeDir: options.environment.homeDir,
      instructionFiles: apps.flatMap((app) => app.instructionFiles),
      manifest,
      mcpServers: apps.flatMap((app) => app.mcpServers),
      projectRoot: root,
      ...(repository === undefined ? {} : { repository }),
      sharedInstructions: toSharedInstructions(sharedPath, sharedContents),
      skills: apps.flatMap((app) => app.skills),
    },
    skipped,
  };
}

/** The core-owned adapter id standing in for snippet resolution, which no adapter performs. */
const SNIPPET_DIAGNOSTIC_ID = "core/snippets";

/** One resolved snippet, or the reason it could not be resolved. */
type SnippetOutcome =
  | { readonly diagnostic: ScanDiagnostic; readonly kind: "failed" }
  | { readonly kind: "resolved"; readonly snippet: ResolvedSnippet };

interface ResolvedSnippets {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly snippets: readonly ResolvedSnippet[];
}

/**
 * Reads and hashes every registered snippet, reporting each one it had to drop.
 *
 * A dropped snippet is invisible in the model, and the features built on it — restoring a
 * hand-edited managed block, most of all — degrade into saying the registry never offered it.
 * That reads as a missing registration rather than an unreadable file, so every failure gets a
 * diagnostic naming the snippet and what actually went wrong.
 */
async function resolveSnippets(
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

  const read = readSnippetSource(snippet, await reader.read(path, { maxBytes: MAX_SNIPPET_BYTES }));
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

/** Usable snippet text, or the one sentence saying why this read produced none. */
type SnippetSource =
  | { readonly content: string; readonly message?: undefined }
  | { readonly content?: undefined; readonly message: string };

function readSnippetSource(snippet: Snippet, source: PathContents): SnippetSource {
  if (!source.exists) {
    return {
      message: `Snippet "${snippet.id}" points at a file that does not exist, so its content is unavailable.`,
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

/**
 * Canonicalizes the directory project-scoped paths are confined to.
 *
 * Resolved through symlinks so the comparison is like-for-like: on macOS a repository under
 * `/tmp` really lives in `/private/tmp`, and every path inside it would otherwise look external.
 */
async function resolveProjectBoundary(
  projectRoot: Promise<string | undefined>,
  cwd: string,
  reader: FileReader,
): Promise<string | undefined> {
  return reader.realPath((await projectRoot) ?? cwd);
}
