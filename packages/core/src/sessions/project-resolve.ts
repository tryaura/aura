import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import type { FileReader } from "../workspace/reader.js";
import { createLimiter } from "../workspace/concurrency.js";

/**
 * Maps recorded working directories to project identities, so parallel worktrees and repeated
 * clones collapse without merging unrelated repositories that share a basename.
 *
 * Resolution is bounded and best-effort, in order of trust:
 *
 * 1. A directory that still exists and is a git checkout identifies itself by its `origin` remote —
 *    the credential-free identity every clone and worktree shares. A linked worktree's
 *    `.git` file is followed to the main checkout's configuration first.
 * 2. A directory that is gone falls back to shape: `<...>/workspaces/<project>/<leaf>` is the
 *    layout parallel-worktree tools use, and `<project>` is the name the user knows.
 * 3. Everything else stays its own path, which the renderer shortens like any other.
 *
 * Only `.git` markers and git config files are ever opened, with a small byte cap. Nothing about
 * the project's own contents is read.
 */

/** Bytes of a git config worth reading: the `[remote "origin"]` block sits well within this. */
const MAX_GIT_CONFIG_BYTES = 65_536;
const MAX_CONCURRENT_PROJECT_RESOLUTIONS = 8;

const GITDIR_POINTER = /^gitdir:\s*(.+)\s*$/mu;

/** A stable grouping key plus the short and collision-safe names shown to a person. */
export interface ProjectIdentity {
  readonly key: string;
  readonly label: string;
  readonly qualifiedLabel: string;
}

/** Resolves every distinct directory once. Keys are directories; values are project labels. */
export async function resolveProjects(
  reader: FileReader,
  directories: Iterable<string>,
): Promise<ReadonlyMap<string, ProjectIdentity>> {
  const limit = createLimiter(MAX_CONCURRENT_PROJECT_RESOLUTIONS);
  const unique = [...new Set(directories)];
  return new Map(
    await Promise.all(
      unique.map((directory) => limit(() => resolveProjectEntry(reader, directory))),
    ),
  );
}

async function resolveProjectEntry(
  reader: FileReader,
  directory: string,
): Promise<readonly [string, ProjectIdentity]> {
  return [directory, await resolveProject(reader, directory)];
}

async function resolveProject(reader: FileReader, directory: string): Promise<ProjectIdentity> {
  const fromGit = await gitProjectName(reader, directory);
  if (fromGit !== undefined) {
    return fromGit;
  }
  return workspaceShapeIdentity(directory) ?? pathIdentity(directory, directory);
}

/** The repository name of a live checkout, or undefined when the directory is not one. */
async function gitProjectName(
  reader: FileReader,
  directory: string,
): Promise<ProjectIdentity | undefined> {
  const marker = await reader.read(join(directory, ".git"), { maxBytes: MAX_GIT_CONFIG_BYTES });
  if (!marker.exists) {
    return undefined;
  }
  if (marker.isDirectory) {
    return configProjectName(reader, join(directory, ".git", "config"), directory);
  }
  const pointer = GITDIR_POINTER.exec(marker.content ?? "")?.[1];
  if (pointer === undefined) {
    return undefined;
  }
  // A linked worktree points at `<main>/.git/worktrees/<name>`; the shared config lives two
  // levels up, and the main checkout's directory names the repository if the config does not.
  const mainGitDir = pointer.includes("/worktrees/") ? dirname(dirname(pointer)) : pointer;
  return configProjectName(reader, join(mainGitDir, "config"), dirname(mainGitDir));
}

/** The origin remote's repository name, or the checkout directory's own name. */
async function configProjectName(
  reader: FileReader,
  configPath: string,
  checkoutDir: string,
): Promise<ProjectIdentity | undefined> {
  const config = await reader.read(configPath, { maxBytes: MAX_GIT_CONFIG_BYTES });
  const url = config.content === undefined ? undefined : originUrl(config.content);
  if (url !== undefined) {
    return repositoryIdentityFromUrl(url) ?? pathIdentity(checkoutDir, basename(checkoutDir));
  }
  return config.exists ? pathIdentity(checkoutDir, basename(checkoutDir)) : undefined;
}

/** The `url` of `[remote "origin"]` in a git config, or undefined. */
function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inOrigin = trimmed.replace(/\s+/gu, " ") === '[remote "origin"]';
      continue;
    }
    if (inOrigin && trimmed.startsWith("url")) {
      const value = trimmed.split("=", 2)[1]?.trim();
      if (value !== undefined && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

/** A credential-free representation of a recorded Git remote, or undefined if it is unsafe. */
export function sanitizeRepositoryUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return undefined;
    }
  }
  const scp = scpRemote(trimmed);
  if (scp !== undefined) {
    return `${scp.host}:${scp.path}`;
  }
  return isAbsolute(trimmed) ? normalize(trimmed) : undefined;
}

/** A canonical remote identity that keeps unrelated same-named repositories apart. */
export function repositoryIdentityFromUrl(url: string): ProjectIdentity | undefined {
  const sanitized = sanitizeRepositoryUrl(url);
  if (sanitized === undefined) {
    return undefined;
  }
  if (sanitized.includes("://")) {
    try {
      const parsed = new URL(sanitized);
      if (parsed.protocol === "file:") {
        return pathIdentity(parsed.pathname, basename(parsed.pathname));
      }
      const host = parsed.host.toLowerCase();
      const path = repositoryPath(parsed.pathname);
      return host === "" || path === undefined ? undefined : remoteIdentity(host, path);
    } catch {
      return undefined;
    }
  }
  const scp = scpRemote(sanitized);
  if (scp !== undefined) {
    const path = repositoryPath(scp.path);
    return path === undefined ? undefined : remoteIdentity(scp.host.toLowerCase(), path);
  }
  return isAbsolute(sanitized)
    ? pathIdentity(sanitized, basename(sanitized.replace(/\/+$/u, "")))
    : undefined;
}

/** `<project>` from a `<...>/workspaces/<project>/<leaf>` path, or undefined. */
function workspaceShapeIdentity(directory: string): ProjectIdentity | undefined {
  const parent = dirname(directory);
  if (basename(dirname(parent)) !== "workspaces") {
    return undefined;
  }
  const name = basename(parent);
  return name === "" ? undefined : pathIdentity(parent, name);
}

function repositoryPath(path: string): string | undefined {
  const withoutEdges = path.replace(/^\/+|\/+$/gu, "");
  const withoutSuffix = withoutEdges.endsWith(".git") ? withoutEdges.slice(0, -4) : withoutEdges;
  return withoutSuffix === "" ? undefined : withoutSuffix;
}

function remoteIdentity(host: string, path: string): ProjectIdentity {
  const label = path.split("/").pop() ?? path;
  const qualifiedLabel = `${host}/${path}`;
  return { key: `remote:${qualifiedLabel}`, label, qualifiedLabel };
}

function pathIdentity(path: string, label: string): ProjectIdentity {
  const normalized = normalize(path);
  return { key: `path:${normalized}`, label, qualifiedLabel: normalized };
}

function scpRemote(value: string): { readonly host: string; readonly path: string } | undefined {
  const match = /^(?:[^@\s/:]+@)?([^\s/:]+):(.+)$/u.exec(value);
  const host = match?.[1];
  const path = match?.[2];
  return host === undefined || path === undefined || path === "" ? undefined : { host, path };
}
