import type {
  AppModel,
  Check,
  FileProblem,
  Finding,
  InstructionDocument,
  ResolvedSharedLink,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import { runChecks } from "@tryaura/core";

/** Canonical shared instruction path every fixture in this package agrees on. */
export const SHARED_PATH = "/home/dev/agents/AGENTS.md";

/** The one detail line INS-002 may only use when a plan really exists. */
export const READY = "Aura can add the missing link with check --fix.";

export interface AppOptions {
  readonly id?: string | undefined;
  readonly instructionFiles?: readonly InstructionDocument[] | undefined;
  readonly link?: ResolvedSharedLink | undefined;
  readonly source?:
    | {
        readonly exists: boolean;
        readonly pathKind?: "directory" | "file" | "symlink" | undefined;
        readonly problem?: FileProblem | undefined;
        readonly symlinkTarget?: string | undefined;
      }
    | undefined;
  readonly support?: "supported" | "unsupported" | undefined;
}

export function app(options: AppOptions = {}): AppModel {
  const id = options.id ?? "codex";
  const entryPath = options.link?.entryPath ?? `/home/dev/.${id}/AGENTS.md`;
  const source = options.source ?? { exists: false };
  return {
    adapterId: id,
    detection: { installed: true, version: "1.0.0" },
    displayName: id,
    instructionFiles: options.instructionFiles ?? [],
    mcpServers: [],
    sharedLink: options.link,
    skills: [],
    sourceFiles: [
      {
        exists: source.exists,
        pathKind: source.pathKind,
        problem: source.problem,
        spec: { id: `${id}.instructions`, kind: "instructions", path: entryPath, scope: "global" },
        symlinkTarget: source.symlinkTarget,
      },
    ],
    support: {
      status: options.support ?? "supported",
      supportedRange: ">=1 <2",
      version: "1.0.0",
    },
  };
}

export function document(path: string, valid: boolean): InstructionDocument {
  return {
    content: "",
    links: [{ kind: "symlink", targetPath: SHARED_PATH, valid }],
    path,
    scope: "global",
    sourceId: "instructions",
  };
}

export function workspace(
  apps: readonly AppModel[],
  content: string | undefined,
  exists = content !== undefined,
  problem?: FileProblem,
): WorkspaceModel {
  return {
    apps,
    cwd: "/workspace",
    homeDir: "/home/dev",
    instructionFiles: apps.flatMap((application) => application.instructionFiles),
    manifest: { exists: false, path: "/home/dev/agents/aura.json", status: "missing" },
    mcpServers: [],
    sharedInstructions: {
      content,
      exists,
      path: SHARED_PATH,
      ...(problem === undefined ? {} : { problem }),
    },
    skills: [],
  };
}

export function onlyFinding(check: Check, model: WorkspaceModel): Finding {
  const finding = runChecks([check], model).findings[0];
  if (finding === undefined) {
    throw new Error(`Expected ${check.id} to report one finding.`);
  }
  return finding;
}
