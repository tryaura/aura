import type {
  Adapter,
  AdapterDetection,
  AdapterFileSpec,
  AdapterFileStatus,
  AdapterSnapshot,
  AdapterSourceFile,
  AppModel,
  Environment,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import type { ScanDiagnostic, ScanPhase } from "./diagnostics.js";
import { createLinkResolver, type LinkResolver } from "./links.js";
import { findProjectRoot } from "./project-root.js";
import { createFileReader, type FileReader } from "./reader.js";
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

/** The outcome of one scan: what the machine looks like, and what went wrong while looking. */
export interface WorkspaceScan {
  /** Problems with the scan itself. Empty on a clean run. */
  readonly diagnostics: readonly ScanDiagnostic[];
  /** The normalized machine state every check runs against. */
  readonly model: WorkspaceModel;
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
  const reader = options.reader ?? createFileReader();
  const context: ScanContext = {
    environment: options.environment,
    links: createLinkResolver(reader),
    reader,
  };

  const [scans, projectRoot] = await Promise.all([
    Promise.all(options.adapters.map((adapter) => scanAdapter(adapter, context))),
    findProjectRoot(options.environment.cwd, reader),
  ]);

  const apps: AppModel[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  for (const scan of scans) {
    if (scan.app !== undefined) {
      apps.push(scan.app);
    }
    diagnostics.push(...scan.diagnostics);
  }

  return {
    diagnostics,
    model: {
      apps,
      cwd: options.environment.cwd,
      homeDir: options.environment.homeDir,
      instructionFiles: apps.flatMap((app) => app.instructionFiles),
      mcpServers: apps.flatMap((app) => app.mcpServers),
      projectRoot,
      skills: apps.flatMap((app) => app.skills),
    },
  };
}

interface ScanContext {
  readonly environment: Environment;
  readonly links: LinkResolver;
  readonly reader: FileReader;
}

/** One adapter's contribution to the scan. `app` is absent when the adapter produced nothing. */
interface AdapterScan {
  readonly app?: AppModel | undefined;
  readonly diagnostics: readonly ScanDiagnostic[];
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

  // A missing application is the normal case on most machines, not something to report.
  if (!detection.installed) {
    return { diagnostics: [] };
  }

  let specs: readonly AdapterFileSpec[];
  try {
    specs = adapter.files(context.environment, detection);
  } catch (error) {
    return { diagnostics: [failure(adapter, "files", error)] };
  }

  const files = await Promise.all(specs.map((spec) => readSpec(spec, context.reader)));
  diagnostics.push(...reportMissing(adapter, files));

  let snapshot = EMPTY_SNAPSHOT;
  try {
    const parsed = adapter.parse({ detection, files });
    snapshot = {
      instructionFiles: parsed.instructionFiles,
      mcpServers: parsed.mcpServers,
      metadata: parsed.metadata,
      skills: parsed.skills,
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
      instructionFiles: await context.links.resolve(snapshot.instructionFiles),
      mcpServers: snapshot.mcpServers,
      metadata: snapshot.metadata,
      skills: snapshot.skills,
      // Contents are dropped here: they were consumed by parse and are not retained beside the
      // documents parsed out of them.
      sourceFiles: files.map(toStatus),
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

async function readSpec(spec: AdapterFileSpec, reader: FileReader): Promise<AdapterSourceFile> {
  const contents = await reader.read(spec.path);
  return { content: contents.content, exists: contents.exists, spec };
}

/**
 * Reports declared paths that were required and absent.
 *
 * Optional paths are the common case — most applications only write config once the user has
 * configured something — so only a required path going missing is worth the user's attention.
 */
function reportMissing(
  adapter: Adapter,
  files: readonly AdapterSourceFile[],
): readonly ScanDiagnostic[] {
  return files
    .filter((file) => !file.exists && file.spec.optional !== true)
    .map((file) => ({
      adapterId: adapter.id,
      message: `${adapter.displayName} expects ${file.spec.kind} at this path, but it does not exist.`,
      path: file.spec.path,
      phase: "read" as const,
    }));
}

function toStatus(file: AdapterSourceFile): AdapterFileStatus {
  return { exists: file.exists, spec: file.spec };
}

function failure(adapter: Adapter, phase: ScanPhase, error: unknown): ScanDiagnostic {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    adapterId: adapter.id,
    message: `${adapter.displayName} failed during ${phase}: ${reason}`,
    phase,
  };
}
