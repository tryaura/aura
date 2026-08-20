import {
  mcpEnvironmentVariableNames,
  type AuraManifestState,
  type Adapter,
  type AppModel,
  type Environment,
  type McpServerDef,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { auraManifestDiagnostics } from "../manifest/diagnostic.js";
import type { RegisteredSkillPack } from "../plugin-registry.js";
import { resolveAuraManifestPath } from "../manifest/protocol.js";
import { readAuraManifest } from "../manifest/read.js";
import {
  type AdapterScan,
  type ScanContext,
  scanAdapter,
  type SkippedApp,
} from "./adapter-scan.js";
import type { ScanDiagnostic } from "./diagnostics.js";
import { createDocumentResolver } from "./documents.js";
import { resolveMcpCatalog } from "./mcp-catalog.js";
import { createMcpProber, type McpProber, type McpProbeSettings } from "./mcp-probes.js";
import { findGitMainWorktreeRoot, findProjectRoot } from "./project-root.js";
import { createCachingReader, createFileReader, type FileReader } from "./reader.js";
import { scanRepository } from "./repository.js";
import { withScanCancellation } from "./scan-cancellation.js";
import { sharedInstructionsPath, toSharedInstructions } from "./shared-links.js";
import { resolveBundledSkills, scanSharedSkills } from "./skills.js";

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
  /**
   * Reachability probing for the MCP servers this scan finds.
   *
   * Omitted means the model carries no probe results at all, which is what a scan that does not
   * read them should ask for: resolving every configured command walks the executable search path.
   * An empty object probes the filesystem only.
   */
  readonly mcpProbes?: McpProbeSettings | undefined;
  /**
   * Called as each adapter's scan starts and settles, so a live surface can show which
   * application is being probed while a slow detect (a version probe, a companion CLI that
   * connects somewhere) is still running. Purely observational: the scan's results and ordering
   * are identical with or without it.
   */
  readonly onAdapterScan?: ((adapterId: string, status: "active" | "complete") => void) | undefined;
  /** Filesystem access. Defaults to the real one. */
  readonly reader?: FileReader | undefined;
  /** Cancels adapter work, including any subprocess Aura is still waiting on. */
  readonly signal?: AbortSignal | undefined;
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

/** Leaves every server exactly as its adapter parsed it, for a scan that asked for no probes. */
const skipMcpProbes: McpProber = (servers) => Promise.resolve(servers);

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
  options.signal?.throwIfAborted();
  const environment = withScanCancellation(
    await canonicalizeEnvironmentPaths(options.environment, reader),
    options.signal,
  );
  options.signal?.throwIfAborted();
  const projectRoot = findProjectRoot(environment.cwd, reader);
  const gitMainWorktreeRoot = projectRoot.then((root) =>
    root === undefined ? undefined : findGitMainWorktreeRoot(root, reader),
  );
  const context: ScanContext = {
    documents: createDocumentResolver(reader),
    environment,
    gitMainWorktreeRoot,
    projectBoundary: resolveProjectBoundary(projectRoot, environment.cwd, reader),
    projectRoot,
    probeMcpServers:
      options.mcpProbes === undefined
        ? skipMcpProbes
        : createMcpProber({ environment, reader, ...options.mcpProbes }),
    reader,
  };
  const sharedPath = sharedInstructionsPath(environment);
  const manifestPath = resolveAuraManifestPath(environment.homeDir);

  // Start every independent scan before awaiting any one of them.
  const scansPending = Promise.all(
    options.adapters.map((adapter) =>
      reportingScan(adapter, context, options.onAdapterScan, options.signal),
    ),
  );
  const repositoryPending = projectRoot.then((found) =>
    found === undefined ? undefined : scanRepository(found, environment, reader),
  );
  const sharedContentsPending = reader.read(sharedPath);
  const manifestContentsPending = reader.read(manifestPath);
  const resolvedCatalogPending = resolveMcpCatalog(options.mcpCatalog ?? [], reader);
  const resolvedSkillsPending = resolveBundledSkills(options.skills ?? [], reader);
  const sharedSkillsPending = scanSharedSkills(environment, reader);
  const scans = await scansPending;
  const root = await projectRoot;
  const mainWorktreeRoot = await gitMainWorktreeRoot;
  const repository = await repositoryPending;
  const sharedContents = await sharedContentsPending;
  const manifestContents = await manifestContentsPending;
  const resolvedCatalog = await resolvedCatalogPending;
  const resolvedSkills = await resolvedSkillsPending;
  const sharedSkills = await sharedSkillsPending;
  options.signal?.throwIfAborted();

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
  diagnostics.push(...resolvedCatalog.diagnostics);
  diagnostics.push(...resolvedSkills.diagnostics);

  return {
    diagnostics,
    model: {
      availableMcpServers: resolvedCatalog.values,
      availableSkills: resolvedSkills.skills,
      apps,
      cwd: environment.cwd,
      ...(mainWorktreeRoot === undefined ? {} : { gitMainWorktreeRoot: mainWorktreeRoot }),
      homeDir: environment.homeDir,
      instructionFiles: apps.flatMap((app) => app.instructionFiles),
      manifest,
      mcpEnvironmentVariables: environmentVariableStates(manifest, environment),
      mcpSecretSightings: apps.flatMap((app) => app.mcpSecretSightings ?? []),
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

/** One adapter's scan bracketed by progress reports; `finally` keeps a throwing scan honest. */
async function reportingScan(
  adapter: Adapter,
  context: ScanContext,
  report: WorkspaceScanOptions["onAdapterScan"],
  signal: AbortSignal | undefined,
): Promise<AdapterScan> {
  reportScan(report, adapter.id, "active");
  try {
    signal?.throwIfAborted();
    const scan = await scanAdapter(adapter, context);
    signal?.throwIfAborted();
    return scan;
  } finally {
    reportScan(report, adapter.id, "complete");
  }
}

/** A progress sink is an observer, so its own failure cannot change the scan it watches. */
function reportScan(
  report: WorkspaceScanOptions["onAdapterScan"],
  adapterId: string,
  status: "active" | "complete",
): void {
  try {
    report?.(adapterId, status);
  } catch {
    // Terminal and embedding observers do not own the scan result.
  }
}

function environmentVariableStates(
  manifest: AuraManifestState,
  environment: Environment,
): WorkspaceModel["mcpEnvironmentVariables"] {
  if (manifest.status !== "ready") {
    return [];
  }
  const names = new Set(
    manifest.value.mcpServers.flatMap((server) => mcpEnvironmentVariableNames(server.transport)),
  );
  return [...names]
    .sort()
    .map((name) => Object.freeze({ isSet: environment.readVariable(name) !== undefined, name }));
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
