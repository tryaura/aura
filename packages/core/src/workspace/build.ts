import type {
  Adapter,
  AppModel,
  Environment,
  McpServerDef,
  Snippet,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { auraManifestDiagnostics } from "../manifest/diagnostic.js";
import type { RegisteredSkillPack } from "../plugin-registry.js";
import { resolveAuraManifestPath } from "../manifest/protocol.js";
import { readAuraManifest } from "../manifest/read.js";
import { type ScanContext, scanAdapter, type SkippedApp } from "./adapter-scan.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import { createDocumentResolver } from "./documents.js";
import { resolveMcpCatalog } from "./mcp-catalog.js";
import { findProjectRoot } from "./project-root.js";
import { createCachingReader, createFileReader, type FileReader } from "./reader.js";
import { scanRepository } from "./repository.js";
import { sharedInstructionsPath, toSharedInstructions } from "./shared-links.js";
import { resolveBundledSkills, scanSharedSkills } from "./skills.js";
import { resolveSnippets } from "./snippet-catalog.js";

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
  /**
   * Registry MCP catalog contributions to load during the same read pass, each bounded by
   * `MAX_MCP_CATALOG_BYTES`. An entry that cannot be loaded is reported as a diagnostic and left
   * out of the model rather than surfaced as a partial one.
   */
  readonly mcpCatalog?: readonly McpServerDef[] | undefined;
  /** Filesystem access. Defaults to the real one. */
  readonly reader?: FileReader | undefined;
  /**
   * Registry snippets to resolve during the same read pass, each bounded by `MAX_SNIPPET_BYTES`.
   * A snippet that cannot be resolved is reported as a diagnostic and left out of the model rather
   * than surfaced as a partial one.
   */
  readonly snippets?: readonly Snippet[] | undefined;
  /** Bundled skills paired with their owning plugin source. */
  readonly skills?: readonly RegisteredSkillPack[] | undefined;
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
  const environment = await canonicalizeEnvironmentPaths(options.environment, reader);
  const projectRoot = findProjectRoot(environment.cwd, reader);
  const context: ScanContext = {
    documents: createDocumentResolver(reader),
    environment,
    projectBoundary: resolveProjectBoundary(projectRoot, environment.cwd, reader),
    projectRoot,
    reader,
  };
  const sharedPath = sharedInstructionsPath(environment);
  const manifestPath = resolveAuraManifestPath(environment.homeDir);

  // Start every independent scan before awaiting any one of them.
  const scansPending = Promise.all(
    options.adapters.map((adapter) => scanAdapter(adapter, context)),
  );
  const repositoryPending = projectRoot.then((found) =>
    found === undefined ? undefined : scanRepository(found, environment, reader),
  );
  const sharedContentsPending = reader.read(sharedPath);
  const manifestContentsPending = reader.read(manifestPath);
  const resolvedSnippetsPending = resolveSnippets(options.snippets ?? [], reader);
  const resolvedCatalogPending = resolveMcpCatalog(options.mcpCatalog ?? [], reader);
  const resolvedSkillsPending = resolveBundledSkills(options.skills ?? [], reader);
  const sharedSkillsPending = scanSharedSkills(environment, reader);
  const scans = await scansPending;
  const root = await projectRoot;
  const repository = await repositoryPending;
  const sharedContents = await sharedContentsPending;
  const manifestContents = await manifestContentsPending;
  const resolvedSnippets = await resolvedSnippetsPending;
  const resolvedCatalog = await resolvedCatalogPending;
  const resolvedSkills = await resolvedSkillsPending;
  const sharedSkills = await sharedSkillsPending;

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
  diagnostics.push(...resolvedCatalog.diagnostics);
  diagnostics.push(...resolvedSkills.diagnostics);

  return {
    diagnostics,
    model: {
      availableMcpServers: resolvedCatalog.values,
      availableSkills: resolvedSkills.skills,
      availableSnippets: resolvedSnippets.values,
      apps,
      cwd: environment.cwd,
      homeDir: environment.homeDir,
      instructionFiles: apps.flatMap((app) => app.instructionFiles),
      manifest,
      mcpServers: apps.flatMap((app) => app.mcpServers),
      projectRoot: root,
      ...(repository === undefined ? {} : { repository }),
      sharedInstructions: toSharedInstructions(sharedPath, sharedContents),
      sharedSkills,
      skills: apps.flatMap((app) => app.skills),
      unusableMcpServers: apps.flatMap((app) => app.unusableMcpServers ?? []),
    },
    skipped,
  };
}

/** Uses one filesystem spelling for every root adapters use to construct paths. */
async function canonicalizeEnvironmentPaths(
  environment: Environment,
  reader: FileReader,
): Promise<Environment> {
  const [cwd, homeDir] = await Promise.all([
    reader.realPath(environment.cwd),
    reader.realPath(environment.homeDir),
  ]);
  return Object.freeze({
    ...environment,
    cwd: cwd ?? environment.cwd,
    homeDir: homeDir ?? environment.homeDir,
  });
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
