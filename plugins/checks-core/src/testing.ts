import { resolve } from "node:path";

import claudeCodePlugin from "@tryaura/adapter-claude-code";
import codexPlugin from "@tryaura/adapter-codex";
import cursorPlugin from "@tryaura/adapter-cursor";
import type {
  AdapterCapabilities,
  AppModel,
  Check,
  DetectedFinding,
  FileProblem,
  Finding,
  GitignoreModel,
  InstructionDocument,
  JsonObject,
  RepositoryPackageManifest,
  ResolvedSharedLink,
  Scope,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { createWorkspaceModel } from "@tryaura/aura-sdk/testing";
import { runChecks } from "@tryaura/core";
import { rememberMcpConvergence, type AppMcpConvergence } from "@tryaura/core/testing";

/**
 * What core would carry into {@link AppModel.capabilities} for a bundled adapter's id.
 *
 * Fixtures name real adapter ids without building real scans, so the helper mirrors core's
 * copy-from-the-adapter step by reading the same declarations off the bundled plugins. Any other
 * id stays undeclared, exactly like a third-party adapter that declares nothing.
 */
const BUNDLED_CAPABILITIES: ReadonlyMap<string, AdapterCapabilities> = new Map(
  [claudeCodePlugin, codexPlugin, cursorPlugin].flatMap((plugin) =>
    (plugin.adapters ?? []).flatMap((adapter) =>
      adapter.capabilities === undefined ? [] : [[adapter.id, adapter.capabilities] as const],
    ),
  ),
);

/** Canonical shared instruction path every fixture in this package agrees on. */
export const SHARED_PATH = "/home/dev/agents/AGENTS.md";

/** The one detail line INS-002 may only use when a plan really exists. */
export const READY = "Aura can add the missing link with check --fix.";

/** Everything a check reads off one application, with defaults for what a test does not care about. */
export interface TestAppOptions {
  readonly adapterId?: string;
  readonly authenticated?: boolean;
  /** Overrides what the fixture derives from {@link BUNDLED_CAPABILITIES} for `adapterId`. */
  readonly capabilities?: AdapterCapabilities;
  readonly displayName?: string;
  readonly installHint?: string;
  readonly instructionFiles?: readonly InstructionDocument[];
  readonly link?: ResolvedSharedLink;
  readonly metadata?: JsonObject;
  /** Installs core's convergence planner for this app, as a real scan would. */
  readonly mcpConvergence?: AppMcpConvergence;
  readonly mcpServers?: AppModel["mcpServers"];
  readonly unusableMcpServers?: AppModel["unusableMcpServers"];
  readonly source?:
    | {
        readonly exists: boolean;
        readonly pathKind?: "directory" | "file" | "symlink";
        readonly problem?: FileProblem;
        readonly symlinkTarget?: string;
      }
    | undefined;
  readonly sources?: AppModel["sourceFiles"];
  readonly status?: AppModel["support"]["status"];
  readonly synthetic?: boolean;
  readonly version?: string;
}

export function app(options: TestAppOptions = {}): AppModel {
  const adapterId = options.adapterId ?? "alpha";
  const source = options.source;
  const sourceFiles: AppModel["sourceFiles"] =
    source === undefined
      ? (options.sources ?? [])
      : [
          {
            exists: source.exists,
            pathKind: source.pathKind,
            problem: source.problem,
            spec: {
              id: `${adapterId}.instructions`,
              kind: "instructions",
              path: options.link?.entryPath ?? `/home/dev/.${adapterId}/AGENTS.md`,
              scope: "global",
            },
            symlinkTarget: source.symlinkTarget,
          },
        ];
  const capabilities = options.capabilities ?? BUNDLED_CAPABILITIES.get(adapterId);
  const built: AppModel = {
    adapterId,
    ...(capabilities === undefined ? {} : { capabilities }),
    detection: {
      authenticated: options.authenticated,
      installed: true,
      version: options.version,
    },
    displayName: options.displayName ?? "Alpha",
    installHint: options.installHint,
    instructionFiles: options.instructionFiles ?? [],
    mcpServers: options.mcpServers ?? [],
    ...(options.unusableMcpServers === undefined
      ? {}
      : { unusableMcpServers: options.unusableMcpServers }),
    metadata: options.metadata,
    skills: [],
    ...(options.link === undefined ? {} : { sharedLink: options.link }),
    sourceFiles,
    support: {
      status: options.status ?? "supported",
      supportedRange: ">=1 <2",
      version: options.version,
    },
    synthetic: options.synthetic,
  };

  if (options.mcpConvergence !== undefined) {
    rememberMcpConvergence(built, options.mcpConvergence);
  }
  return built;
}

/** Everything the fixture fills in for what a test does not say about an instruction file. */
export interface TestDocumentOptions {
  /** What core resolved `path` to. Defaults to the resolved `path`, as a regular file does. */
  readonly canonicalPath?: string;
  readonly metadata?: JsonObject;
  readonly scope?: Scope;
}

/** One instruction file, with defaults for what a test does not care about. */
export function document(
  path: string,
  content: string,
  options: TestDocumentOptions = {},
): InstructionDocument {
  return {
    canonicalPath: options.canonicalPath ?? resolve(path),
    content,
    links: [],
    metadata: options.metadata,
    path,
    scope: options.scope ?? "global",
    sourceId: `test:${path}`,
  };
}

/** {@link document}, carrying a symlink to {@link SHARED_PATH} that either resolved or broke. */
export function linkedDocument(
  path: string,
  valid: boolean,
  options: TestDocumentOptions = {},
): InstructionDocument {
  return {
    ...document(path, "", options),
    links: [{ kind: "symlink", targetPath: SHARED_PATH, valid }],
  };
}

/** A workspace that is not inside a repository, so project-scoped checks stay silent. */
export function model(
  options: {
    readonly apps?: readonly AppModel[];
    /** Documents the apps do not carry, for checks that read the workspace-wide list directly. */
    readonly instructionFiles?: readonly InstructionDocument[];
    readonly manifest?: WorkspaceModel["manifest"];
    readonly sharedInstructions?: {
      readonly content?: string | undefined;
      readonly exists: boolean;
      readonly problem?: FileProblem | undefined;
    };
  } = {},
): WorkspaceModel {
  const apps = options.apps ?? [];
  return createWorkspaceModel({
    apps,
    instructionFiles: [
      ...apps.flatMap((candidate) => candidate.instructionFiles),
      ...(options.instructionFiles ?? []),
    ],
    manifest:
      options.manifest ??
      ({
        exists: false,
        path: "/home/dev/agents/aura.json",
        status: "missing",
      } satisfies WorkspaceModel["manifest"]),
    mcpServers: apps.flatMap((candidate) => candidate.mcpServers),
    unusableMcpServers: apps.flatMap((candidate) => candidate.unusableMcpServers ?? []),
    // Absent by default: the environment checks never read it, and a fixture that claimed a shared
    // source exists would make unrelated INS checks inherit state they did not ask for.
    sharedInstructions: {
      exists: options.sharedInstructions?.exists ?? false,
      path: SHARED_PATH,
      ...(options.sharedInstructions?.content === undefined
        ? {}
        : { content: options.sharedInstructions.content }),
      ...(options.sharedInstructions?.problem === undefined
        ? {}
        : { problem: options.sharedInstructions.problem }),
    },
    skills: apps.flatMap((candidate) => candidate.skills),
  });
}

/** Builds the shared-instruction workspace shape used by INS-001 and INS-002 tests. */
export function workspace(
  apps: readonly AppModel[],
  content: string | undefined,
  options: { readonly exists?: boolean; readonly problem?: FileProblem } = {},
): WorkspaceModel {
  return model({
    apps,
    sharedInstructions: {
      content,
      exists: options.exists ?? content !== undefined,
      problem: options.problem,
    },
  });
}

export function onlyFinding(check: Check, workspaceModel: WorkspaceModel): Finding {
  const finding = runChecks([check], workspaceModel).findings[0];
  if (finding === undefined) {
    throw new Error(`Expected ${check.id} to report one finding.`);
  }
  return finding;
}

/** Where the repository state a project-scoped check reads comes from. */
export interface TestRepositoryOptions {
  readonly apps?: readonly AppModel[];
  readonly infoExclude?: GitignoreModel;
  readonly instructionFiles?: readonly InstructionDocument[];
  readonly packageManifests?: readonly RepositoryPackageManifest[];
  readonly trackedAgentPaths?: readonly string[];
}

/** A workspace whose cwd sits below the repository root, as it usually does in practice. */
export function projectModel(
  rootGitignore: GitignoreModel,
  options: TestRepositoryOptions = {},
): WorkspaceModel {
  return {
    ...model({
      apps: options.apps ?? [],
      instructionFiles: options.instructionFiles ?? [],
    }),
    cwd: "/repo/packages/app",
    projectRoot: "/repo",
    repository: {
      gitignore: rootGitignore,
      packageManifests: options.packageManifests ?? [],
      trackedAgentPaths: options.trackedAgentPaths ?? [],
      ...(options.infoExclude === undefined ? {} : { infoExclude: options.infoExclude }),
    },
  };
}

export function gitignore(
  content: string,
  exists = true,
  path = "/repo/.gitignore",
): GitignoreModel {
  return {
    content,
    exists,
    path,
    patterns: content
      .split(/\r?\n/u)
      .flatMap((value, index) =>
        value.trim() === "" || value.startsWith("#") ? [] : [{ line: index + 1, value }],
      ),
  };
}

/** Stamps a detected finding the way core does, so `fix` can be called with a real `Finding`. */
export function requireFinding(
  finding: DetectedFinding | undefined,
  checkId: string,
  scope: Finding["scope"],
  severity: Finding["severity"],
): Finding {
  if (finding === undefined) {
    throw new Error(`expected ${checkId} finding`);
  }
  return { ...finding, checkId, scope, severity };
}
