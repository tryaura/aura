import type { Adapter, AppModel, Environment, WorkspaceModel } from "@tryaura/aura-sdk";

import { auraManifestDiagnostics } from "../manifest/diagnostic.js";
import { resolveAuraManifestPath } from "../manifest/protocol.js";
import { readAuraManifest } from "../manifest/read.js";
import { type ScanContext, scanAdapter, type SkippedApp } from "./adapter-scan.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import { createLinkResolver } from "./links.js";
import { findProjectRoot } from "./project-root.js";
import { createCachingReader, createFileReader, type FileReader } from "./reader.js";
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
    environment: options.environment,
    links: createLinkResolver(reader),
    projectBoundary: resolveProjectBoundary(projectRoot, options.environment.cwd, reader),
    projectRoot,
    reader,
  };
  const sharedPath = sharedInstructionsPath(options.environment);
  const manifestPath = resolveAuraManifestPath(options.environment.homeDir);

  // The repository scan needs only the project root, so it runs alongside the adapters rather than
  // after them: its Git probes are latency the scan would otherwise pay end to end.
  const [scans, root, repository, sharedContents, manifestContents] = await Promise.all([
    Promise.all(options.adapters.map((adapter) => scanAdapter(adapter, context))),
    projectRoot,
    projectRoot.then((found) =>
      found === undefined ? undefined : scanRepository(found, options.environment, reader),
    ),
    reader.read(sharedPath),
    reader.read(manifestPath),
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

  return {
    diagnostics,
    model: {
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
