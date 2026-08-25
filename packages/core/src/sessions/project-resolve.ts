import { basename, dirname, join } from "node:path";

import type { FileReader } from "../workspace/reader.js";

/**
 * Maps recorded working directories to project labels, so parallel worktrees and repeated clones
 * of one repository collapse into one report subject.
 *
 * Resolution is bounded and best-effort, in order of trust:
 *
 * 1. A directory that still exists and is a git checkout names itself after its `origin` remote —
 *    the one identity every clone and worktree of a repository shares. A linked worktree's
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

const GITDIR_POINTER = /^gitdir:\s*(.+)\s*$/mu;

/** Resolves every distinct directory once. Keys are directories; values are project labels. */
export async function resolveProjects(
  reader: FileReader,
  directories: Iterable<string>,
): Promise<ReadonlyMap<string, string>> {
  const labels = new Map<string, string>();
  for (const directory of new Set(directories)) {
    labels.set(directory, await resolveProject(reader, directory));
  }
  return labels;
}

async function resolveProject(reader: FileReader, directory: string): Promise<string> {
  const fromGit = await gitProjectName(reader, directory);
  if (fromGit !== undefined) {
    return fromGit;
  }
  return workspaceShapeName(directory) ?? directory;
}

/** The repository name of a live checkout, or undefined when the directory is not one. */
async function gitProjectName(reader: FileReader, directory: string): Promise<string | undefined> {
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
): Promise<string | undefined> {
  const config = await reader.read(configPath, { maxBytes: MAX_GIT_CONFIG_BYTES });
  const url = config.content === undefined ? undefined : originUrl(config.content);
  if (url !== undefined) {
    return repositoryName(url) ?? basename(checkoutDir);
  }
  return config.exists ? basename(checkoutDir) : undefined;
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

/** The final path segment of a remote URL, without `.git`: the name clones share. */
function repositoryName(url: string): string | undefined {
  const tail = url.replace(/\/+$/u, "").split(/[/:]/u).pop();
  const name = tail?.endsWith(".git") ? tail.slice(0, -4) : tail;
  return name === undefined || name === "" ? undefined : name;
}

/** `<project>` from a `<...>/workspaces/<project>/<leaf>` path, or undefined. */
function workspaceShapeName(directory: string): string | undefined {
  const parent = dirname(directory);
  if (basename(dirname(parent)) !== "workspaces") {
    return undefined;
  }
  const name = basename(parent);
  return name === "" ? undefined : name;
}
