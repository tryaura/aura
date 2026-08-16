import type {
  Adapter,
  AdapterDetection,
  AdapterFileStatus,
  AdapterSnapshot,
  AdapterSourceFile,
  AppModel,
  Environment,
  ResolvedSharedLink,
  SharedInstructionsState,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { auraManifestDiagnostics } from "../manifest/diagnostic.js";
import { resolveAuraManifestPath } from "../manifest/protocol.js";
import { readAuraManifest } from "../manifest/read.js";
import { describeFailure, type ScanDiagnostic, type ScanPhase } from "./diagnostics.js";
import { type AdapterFileDiscovery, discoverAdapterFiles } from "./discovery.js";
import { createLinkResolver, type LinkResolver } from "./links.js";
import { findProjectRoot } from "./project-root.js";
import { createCachingReader, createFileReader, type FileReader } from "./reader.js";
import { scanRepository } from "./repository.js";
import { resolveAdapterSharedLink, sharedInstructionsPath } from "./shared-links.js";
import { evaluateSupport, isComparableRange } from "./support.js";

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

/** An application whose adapter ran and reported it absent. */
export interface SkippedApp {
  /** The {@link Adapter.id} that reported the application absent. */
  readonly adapterId: string;
  /** Human-readable application name. */
  readonly displayName: string;
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

interface ScanContext {
  readonly environment: Environment;
  readonly links: LinkResolver;
  /** Canonical directory project-scoped paths must stay inside. Awaited once per adapter. */
  readonly projectBoundary: Promise<string | undefined>;
  readonly projectRoot: Promise<string | undefined>;
  readonly reader: FileReader;
}

/** One adapter's contribution to the scan. `app` is absent when the adapter produced nothing. */
interface AdapterScan {
  readonly app?: AppModel | undefined;
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skipped?: SkippedApp | undefined;
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

/**
 * Walks one adapter through detect, files, read, and parse.
 *
 * Every plugin call is guarded. A plugin runs with the full privileges of the process and is
 * trusted to that extent, but one that throws must not take the rest of the scan with it: the user
 * still gets findings for the applications that did parse, plus a diagnostic naming the offender.
 */
async function scanAdapter(adapter: Adapter, context: ScanContext): Promise<AdapterScan> {
  const diagnostics: ScanDiagnostic[] = [];

  let detection: AdapterDetection;
  try {
    detection = await adapter.detect(context.environment);
  } catch (error) {
    return { diagnostics: [failure(adapter, "detect", error)] };
  }

  if (!detection.installed) {
    return {
      diagnostics: [],
      skipped: { adapterId: adapter.id, displayName: adapter.displayName },
    };
  }

  let discovery: AdapterFileDiscovery;
  try {
    discovery = await discoverAdapterFiles(adapter, {
      detection,
      environment: context.environment,
      projectBoundary: await context.projectBoundary,
      reader: context.reader,
    });
  } catch (error) {
    return { diagnostics: [failure(adapter, "files", error)] };
  }

  diagnostics.push(...discovery.diagnostics);

  let sharedLink: ResolvedSharedLink | undefined;
  try {
    sharedLink = resolveAdapterSharedLink(adapter, context.environment, discovery.files);
  } catch (error) {
    diagnostics.push(failure(adapter, "files", error));
  }

  let snapshot = EMPTY_SNAPSHOT;
  try {
    const parsed = adapter.parse({
      cwd: context.environment.cwd,
      detection,
      files: discovery.files,
      homeDir: context.environment.homeDir,
      projectRoot: await context.projectRoot,
    });
    snapshot = {
      instructionFiles: await context.links.resolve(parsed.instructionFiles),
      mcpServers: [...parsed.mcpServers],
      metadata: parsed.metadata,
      skills: [...parsed.skills],
    };
  } catch (error) {
    diagnostics.push(failure(adapter, "parse", error));
  }

  if (!isComparableRange(adapter.supportedRange)) {
    diagnostics.push({
      adapterId: adapter.id,
      message: `${adapter.displayName} declares an unparsable supported range: ${adapter.supportedRange}`,
      phase: "support",
    });
  }

  return {
    app: {
      adapterId: adapter.id,
      detection,
      displayName: adapter.displayName,
      ...(adapter.installHint === undefined ? {} : { installHint: adapter.installHint }),
      instructionFiles: snapshot.instructionFiles,
      mcpServers: snapshot.mcpServers,
      metadata: snapshot.metadata,
      skills: snapshot.skills,
      // Contents are dropped here: they were consumed by parse and are not retained beside the
      // documents parsed out of them.
      sourceFiles: [...discovery.files.values()].map(toStatus),
      ...(sharedLink === undefined ? {} : { sharedLink }),
      support: evaluateSupport(adapter.supportedRange, detection.version),
    },
    diagnostics,
  };
}

/** What an application contributes when its adapter failed to parse anything. */
const EMPTY_SNAPSHOT: AdapterSnapshot = Object.freeze({
  instructionFiles: [],
  mcpServers: [],
  skills: [],
});

function toStatus(file: AdapterSourceFile): AdapterFileStatus {
  return {
    exists: file.exists,
    ...(file.pathKind === undefined ? {} : { pathKind: file.pathKind }),
    problem: file.problem,
    spec: file.spec,
    ...(file.symlinkTarget === undefined ? {} : { symlinkTarget: file.symlinkTarget }),
  };
}

function toSharedInstructions(
  path: string,
  contents: Awaited<ReturnType<FileReader["read"]>>,
): SharedInstructionsState {
  const problem =
    contents.problem ??
    (contents.exists && (contents.isDirectory || contents.content === undefined)
      ? "unsupported"
      : undefined);
  return {
    content: contents.content,
    exists: contents.exists,
    path,
    problem,
  };
}

/** Records a plugin failure without repeating what the plugin said. */
function failure(adapter: Adapter, phase: ScanPhase, error: unknown): ScanDiagnostic {
  return {
    adapterId: adapter.id,
    detail: describeFailure(error),
    message: `${adapter.displayName} failed during ${phase}. This is a bug in the ${adapter.id} adapter; report it to whoever ships the plugin.`,
    phase,
  };
}
