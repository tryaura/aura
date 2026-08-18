import { resolveSkillDirectory } from "@tryaura/aura-sdk";
import type {
  Adapter,
  AdapterDetection,
  AdapterFileStatus,
  AdapterSnapshot,
  AdapterSourceFile,
  AppModel,
  Environment,
  ResolvedSharedLink,
} from "@tryaura/aura-sdk";

import {
  describeAdapterProblems,
  describeFailure,
  type ScanDiagnostic,
  type ScanPhase,
} from "./diagnostics.js";
import { type AdapterFileDiscovery, discoverAdapterFiles } from "./discovery.js";
import type { DocumentResolver } from "./documents.js";
import type { FileReader } from "./reader.js";
import type { McpProber } from "./mcp-probes.js";
import { resolveAdapterProjectSharedLink, resolveAdapterSharedLink } from "./shared-links.js";
import { evaluateSupport, isComparableRange } from "./support.js";
import { createAppMcpConvergence } from "./mcp-convergence.js";
import { rememberMcpConvergence } from "./mcp-plan.js";

/** What one adapter needs from the surrounding scan to run its lifecycle. */
export interface ScanContext {
  readonly documents: DocumentResolver;
  readonly environment: Environment;
  /** Canonical directory project-scoped paths must stay inside. Awaited once per adapter. */
  readonly projectBoundary: Promise<string | undefined>;
  readonly projectRoot: Promise<string | undefined>;
  readonly probeMcpServers: McpProber;
  readonly reader: FileReader;
}

/** An application whose adapter ran and reported it absent. */
export interface SkippedApp {
  /** The {@link Adapter.id} that reported the application absent. */
  readonly adapterId: string;
  /** Human-readable application name. */
  readonly displayName: string;
}

/** One adapter's contribution to the scan. `app` is absent when the adapter produced nothing. */
export interface AdapterScan {
  readonly app?: AppModel | undefined;
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly skipped?: SkippedApp | undefined;
}

/**
 * Walks one adapter through detect, files, read, and parse.
 *
 * Every plugin call is guarded. A plugin runs with the full privileges of the process and is
 * trusted to that extent, but one that throws must not take the rest of the scan with it: the user
 * still gets findings for the applications that did parse, plus a diagnostic naming the offender.
 */
export async function scanAdapter(adapter: Adapter, context: ScanContext): Promise<AdapterScan> {
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
      projectRoot: await context.projectRoot,
      reader: context.reader,
    });
  } catch (error) {
    return { diagnostics: [failure(adapter, "files", error)] };
  }

  diagnostics.push(...discovery.diagnostics);

  let projectSharedLink: ResolvedSharedLink | undefined;
  let sharedLink: ResolvedSharedLink | undefined;
  try {
    sharedLink = resolveAdapterSharedLink(adapter, context.environment, discovery.files);
    projectSharedLink = resolveAdapterProjectSharedLink(
      adapter,
      context.environment,
      discovery.files,
      await context.projectRoot,
    );
  } catch (error) {
    diagnostics.push(failure(adapter, "files", error));
  }

  const parse = await parseAdapter(adapter, detection, discovery, context);
  const snapshot = parse.snapshot;
  diagnostics.push(...parse.diagnostics);
  const mcpServers = await context.probeMcpServers(snapshot.mcpServers);

  if (!isComparableRange(adapter.supportedRange)) {
    diagnostics.push({
      adapterId: adapter.id,
      message: `${adapter.displayName} declares an unparsable supported range: ${adapter.supportedRange}`,
      phase: "support",
    });
  }

  const app: AppModel = {
    adapterId: adapter.id,
    ...(adapter.capabilities === undefined ? {} : { capabilities: adapter.capabilities }),
    detection,
    displayName: adapter.displayName,
    ...(adapter.installHint === undefined ? {} : { installHint: adapter.installHint }),
    instructionFiles: snapshot.instructionFiles,
    mcpServers,
    metadata: snapshot.metadata,
    skills: snapshot.skills,
    skillDirectories: (adapter.capabilities?.skills?.directories ?? []).map((directory) =>
      resolveSkillDirectory(directory, context.environment.homeDir, context.environment.cwd),
    ),
    // Contents are dropped here: they were consumed by parse and are not retained beside the
    // documents parsed out of them.
    sourceFiles: [...discovery.files.values()]
      .filter((file) => file.spec.kind !== "probe")
      .map(toStatus),
    ...(projectSharedLink === undefined ? {} : { projectSharedLink }),
    ...(sharedLink === undefined ? {} : { sharedLink }),
    support: evaluateSupport(adapter.supportedRange, detection.version),
    ...(adapter.synthetic === undefined ? {} : { synthetic: adapter.synthetic }),
    ...(snapshot.unusableMcpServers === undefined
      ? {}
      : { unusableMcpServers: snapshot.unusableMcpServers }),
  };

  // Registered rather than attached: the planner holds the bytes this model promises not to keep.
  const convergence = createAppMcpConvergence(adapter, discovery.files, {
    servers: mcpServers,
    unusable: snapshot.unusableMcpServers ?? [],
  });
  if (convergence !== undefined) {
    rememberMcpConvergence(app, convergence);
  }

  return { app, diagnostics };
}

/**
 * Hands one adapter its files and normalizes what it makes of them.
 *
 * Guarded like every other plugin call: an adapter that throws loses its own snapshot and nothing
 * else. The files it read but could not use are a different thing entirely — those are reported as
 * the adapter's own diagnostics, since only it can tell a corrupt config from an empty one.
 */
async function parseAdapter(
  adapter: Adapter,
  detection: AdapterDetection,
  discovery: AdapterFileDiscovery,
  context: ScanContext,
): Promise<{ diagnostics: readonly ScanDiagnostic[]; snapshot: AdapterSnapshot }> {
  try {
    const parsed = adapter.parse({
      cwd: context.environment.cwd,
      detection,
      files: discovery.files,
      homeDir: context.environment.homeDir,
      projectRoot: await context.projectRoot,
    });
    return {
      diagnostics: describeAdapterProblems(adapter, parsed.problems ?? [], discovery.files),
      snapshot: {
        instructionFiles: await context.documents.resolve(parsed.instructionFiles),
        mcpServers: [...parsed.mcpServers],
        metadata: parsed.metadata,
        skills: [...parsed.skills],
        unusableMcpServers: [...(parsed.unusableMcpServers ?? [])],
      },
    };
  } catch (error) {
    return { diagnostics: [failure(adapter, "parse", error)], snapshot: EMPTY_SNAPSHOT };
  }
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
    ...(file.resolvedPath === undefined ? {} : { resolvedPath: file.resolvedPath }),
    ...(file.size === undefined ? {} : { size: file.size }),
    spec: file.spec,
    ...(file.symlinkTarget === undefined ? {} : { symlinkTarget: file.symlinkTarget }),
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
