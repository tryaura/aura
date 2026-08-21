import { dirname, isAbsolute, join, relative } from "node:path";

import type { AuraManifest, AuraTeamPreset, Environment, RepoContentSet } from "@tryaura/aura-sdk";

import { hashContent } from "../content-hash.js";
import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import { findGitMainWorktreeRoot, findProjectRoot } from "../workspace/project-root.js";
import { createFileReader, type FileReader } from "../workspace/reader.js";
import { resolveTeamPresetPath } from "./protocol.js";
import { readTeamPreset } from "./read.js";
import { readRepoContent } from "./repo-content.js";

/** Selects which repository-authored content a caller needs beyond the trust hash. */
export interface RepoPresetReadOptions {
  /** Skill trees are omitted by read-only commands that never install them. */
  readonly includeSkills?: boolean | undefined;
}

/**
 * The identities one repository preset may have been trusted under.
 *
 * A linked worktree is the same repository as the checkout its `.git` file points into — one
 * object store, one config, one push destination — so a consent decision belongs to that checkout
 * rather than to the directory a run happened to start in. Both identities are compared against
 * recorded entries; neither is ever opened, so trusting a worktree never reaches into another
 * branch's file.
 */
export interface RepoPresetIdentity {
  /**
   * Same preset path resolved against the repository's primary Git checkout.
   *
   * Absent outside a Git checkout and inside the primary checkout itself, where it would repeat
   * {@link RepoPresetIdentity.path}.
   */
  readonly mainWorktreePath?: string | undefined;
  /** Canonical absolute path of the repository preset file, whether or not it exists. */
  readonly path: string;
}

/** The repository preset file as read for this run, before any trust decision. */
export interface RepoPresetState extends RepoPresetIdentity {
  /**
   * Repository content requested by the caller, read alongside the preset.
   *
   * This snapshot is what catalogs and planners consume; nothing repo-defined is ever re-read
   * from disk after this point, so the bytes the trust hash covered are the bytes a run applies.
   */
  readonly contentSet?: RepoContentSet | undefined;
  readonly diagnostics: readonly ScanDiagnostic[];
  /**
   * Present only when the file and its content set were readable and valid.
   *
   * Covers the preset text and every snippet body: with no snippets it is exactly the preset's
   * own {@link hashRepoPreset}, so existing trust records keep matching.
   */
  readonly hash?: string | undefined;
  readonly preset?: AuraTeamPreset | undefined;
  readonly status: "invalid" | "missing" | "ready";
}

/**
 * Hashes repository preset contents for the trust record.
 *
 * Normalizes line endings so a checkout that rewrites them does not invalidate a trust the user
 * already granted to the same bytes-as-authored.
 */
export function hashRepoPreset(content: string): string {
  return hashContent(content);
}

/** Reads and validates the repository preset below the invoking directory. */
export async function readRepoPreset(
  environment: Environment,
  reader: FileReader = createFileReader(),
  options: RepoPresetReadOptions = {},
): Promise<RepoPresetState> {
  // One filesystem spelling, as the workspace scan does for its own roots: a trust record outlives
  // the run that wrote it, and `/tmp` and `/private/tmp` naming the same file must compare equal.
  const cwd = (await reader.realPath(environment.cwd)) ?? environment.cwd;
  const path = resolveTeamPresetPath(cwd);
  const state = await readTeamPreset(cwd, reader);
  if (state.status !== "ready" || state.preset === undefined || state.content === undefined) {
    return { diagnostics: state.diagnostics, path, status: state.status };
  }
  const content = await readRepoContent(
    dirname(path),
    state.preset,
    state.content,
    reader,
    options,
  );
  if (content.status === "invalid") {
    return {
      diagnostics: [...state.diagnostics, ...content.diagnostics],
      path,
      status: "invalid",
    };
  }
  const mainWorktreePath = await resolveMainWorktreePresetPath(cwd, path, reader);
  return {
    contentSet: content.contentSet,
    diagnostics: [...state.diagnostics, ...content.diagnostics],
    hash: content.hash,
    ...(mainWorktreePath === undefined ? {} : { mainWorktreePath }),
    path,
    preset: state.preset,
    status: "ready",
  };
}

/** Whether the manifest records an acceptance of exactly these contents for this repository. */
export function isRepoPresetTrusted(
  manifest: AuraManifest | undefined,
  identity: RepoPresetIdentity,
  hash: string,
): boolean {
  return (manifest?.trustedRepoPresets ?? []).some(
    (entry) =>
      entry.hash === hash &&
      (entry.path === identity.path ||
        (identity.mainWorktreePath !== undefined &&
          (entry.path === identity.mainWorktreePath ||
            entry.mainWorktreePath === identity.mainWorktreePath))),
  );
}

/**
 * Resolves the same preset path inside the repository's primary Git checkout.
 *
 * The preset keeps its position within the repository, so a run below the worktree root maps onto
 * the matching subdirectory of the primary checkout rather than onto its root. Returns undefined
 * outside a Git checkout, inside the primary checkout itself, and for any layout Git's own
 * `.git`-file convention does not describe.
 */
async function resolveMainWorktreePresetPath(
  cwd: string,
  path: string,
  reader: FileReader,
): Promise<string | undefined> {
  const projectRoot = await findProjectRoot(cwd, reader);
  if (projectRoot === undefined) {
    return undefined;
  }
  const mainWorktreeRoot = await findGitMainWorktreeRoot(projectRoot, reader);
  if (mainWorktreeRoot === undefined) {
    return undefined;
  }
  const within = relative(projectRoot, cwd);
  if (within.startsWith("..") || isAbsolute(within)) {
    return undefined;
  }
  const candidate = resolveTeamPresetPath(join(mainWorktreeRoot, within));
  return candidate === path ? undefined : candidate;
}
