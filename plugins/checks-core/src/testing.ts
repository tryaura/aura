import type {
  AppModel,
  DetectedFinding,
  Finding,
  GitignoreModel,
  JsonObject,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

/** Everything a check reads off one application, with defaults for what a test does not care about. */
export interface TestAppOptions {
  readonly adapterId?: string;
  readonly authenticated?: boolean;
  readonly displayName?: string;
  readonly installHint?: string;
  readonly metadata?: JsonObject;
  readonly sources?: AppModel["sourceFiles"];
  readonly status?: AppModel["support"]["status"];
  readonly version?: string;
}

export function app(options: TestAppOptions = {}): AppModel {
  return {
    adapterId: options.adapterId ?? "alpha",
    detection: {
      authenticated: options.authenticated,
      installed: true,
      version: options.version,
    },
    displayName: options.displayName ?? "Alpha",
    installHint: options.installHint,
    instructionFiles: [],
    mcpServers: [],
    metadata: options.metadata,
    skills: [],
    sourceFiles: options.sources ?? [],
    support: {
      status: options.status ?? "supported",
      supportedRange: ">=1 <2",
      version: options.version,
    },
  };
}

/** A workspace that is not inside a repository, so project-scoped checks stay silent. */
export function model(options: { readonly apps?: readonly AppModel[] } = {}): WorkspaceModel {
  const apps = options.apps ?? [];
  return {
    apps,
    cwd: "/workspace",
    homeDir: "/home/dev",
    instructionFiles: apps.flatMap((candidate) => candidate.instructionFiles),
    mcpServers: apps.flatMap((candidate) => candidate.mcpServers),
    // Absent by default: the environment checks never read it, and a fixture that claimed a shared
    // source exists would make the INS checks disagree with the one in `fixtures.ts`.
    sharedInstructions: { exists: false, path: "/home/dev/agents/AGENTS.md" },
    skills: apps.flatMap((candidate) => candidate.skills),
  };
}

/** Where the repository state a project-scoped check reads comes from. */
export interface TestRepositoryOptions {
  readonly apps?: readonly AppModel[];
  readonly infoExclude?: GitignoreModel;
  readonly trackedAgentPaths?: readonly string[];
}

/** A workspace whose cwd sits below the repository root, as it usually does in practice. */
export function projectModel(
  rootGitignore: GitignoreModel,
  options: TestRepositoryOptions = {},
): WorkspaceModel {
  return {
    ...model({ apps: options.apps ?? [] }),
    cwd: "/repo/packages/app",
    projectRoot: "/repo",
    repository: {
      gitignore: rootGitignore,
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
