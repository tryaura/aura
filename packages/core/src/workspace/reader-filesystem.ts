import { Buffer, isUtf8 } from "node:buffer";
import type { Stats } from "node:fs";
import { lstat, open, opendir, readFile, readlink, realpath, stat } from "node:fs/promises";

import type { AdapterPathKind, FileProblem } from "@tryaura/aura-sdk";

import { errorCode } from "../values.js";
import { isEmbeddedAssetPath } from "./embedded-assets.js";
import { MAX_DIRECTORY_ENTRIES, MAX_FILE_BYTES } from "./reader-limits.js";
import type { FileReadOptions, PathContents } from "./reader.js";

const MISSING: PathContents = Object.freeze({ exists: false, isDirectory: false });

export async function pathExists(path: string): Promise<boolean> {
  try {
    await compatibleLstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function inspectPath(path: string): Promise<PathContents> {
  let stats: Stats;
  try {
    stats = await compatibleLstat(path);
  } catch (error) {
    return isAbsence(error) ? MISSING : { ...MISSING, problem: toProblem(error) };
  }

  if (!stats.isSymbolicLink()) {
    return inspectedContents(stats, stats.isDirectory() ? "directory" : "file");
  }

  let symlinkTarget: string;
  try {
    symlinkTarget = await readlink(path);
  } catch (error) {
    return { exists: true, isDirectory: false, pathKind: "symlink", problem: toProblem(error) };
  }

  try {
    return inspectedContents(await stat(path), "symlink", symlinkTarget);
  } catch (error) {
    return isAbsence(error)
      ? { exists: true, isDirectory: false, pathKind: "symlink", symlinkTarget }
      : {
          exists: true,
          isDirectory: false,
          pathKind: "symlink",
          problem: toProblem(error),
          symlinkTarget,
        };
  }
}

function inspectedContents(
  stats: Stats,
  pathKind: AdapterPathKind,
  symlinkTarget?: string,
): PathContents {
  const metadata = {
    pathKind,
    ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
  };
  if (stats.isDirectory()) {
    return { ...metadata, exists: true, isDirectory: true };
  }
  if (stats.isFile()) {
    return {
      ...metadata,
      exists: true,
      isDirectory: false,
      mode: fileMode(stats),
      size: stats.size,
    };
  }
  return { ...metadata, exists: true, isDirectory: false, problem: "unsupported" };
}

export async function readPath(path: string, options?: FileReadOptions): Promise<PathContents> {
  let stats: Stats;
  try {
    stats = await compatibleLstat(path);
  } catch (error) {
    return isAbsence(error) ? MISSING : { ...MISSING, problem: toProblem(error) };
  }

  if (stats.isSymbolicLink()) {
    return readSymbolicLink(path, options);
  }
  if (stats.isDirectory()) {
    return readResolvedPath(path, stats, "directory", undefined, options);
  }
  if (!stats.isFile()) {
    return { exists: true, isDirectory: false, problem: "unsupported" };
  }
  return readResolvedPath(path, stats, "file", undefined, options);
}

async function readSymbolicLink(path: string, options?: FileReadOptions): Promise<PathContents> {
  let symlinkTarget: string;
  try {
    symlinkTarget = await readlink(path);
  } catch (error) {
    return {
      exists: true,
      isDirectory: false,
      pathKind: "symlink",
      problem: toProblem(error),
    };
  }

  let targetStats: Stats;
  try {
    targetStats = await stat(path);
  } catch (error) {
    return isAbsence(error)
      ? { exists: true, isDirectory: false, pathKind: "symlink", symlinkTarget }
      : {
          exists: true,
          isDirectory: false,
          pathKind: "symlink",
          problem: toProblem(error),
          symlinkTarget,
        };
  }
  return readResolvedPath(path, targetStats, "symlink", symlinkTarget, options);
}

async function readResolvedPath(
  path: string,
  stats: Stats,
  pathKind: AdapterPathKind,
  symlinkTarget?: string,
  options?: FileReadOptions,
): Promise<PathContents> {
  const metadata = resolvedMetadata(stats, pathKind, symlinkTarget, options);
  if (stats.isDirectory()) {
    return readDirectory(path, metadata);
  }
  if (!stats.isFile()) {
    return { ...metadata, exists: true, isDirectory: false, problem: "unsupported" };
  }

  return readRegularFile(path, stats, metadata, options);
}

/**
 * `lstat` for real paths, `stat` for files embedded in a compiled executable.
 *
 * The fallback loses nothing: an embedded filesystem has no symlinks, so the two calls agree
 * wherever both work. Non-embedded failures keep their original error.
 */
async function compatibleLstat(path: string): Promise<Stats> {
  try {
    return await lstat(path);
  } catch (error) {
    if (!isEmbeddedAssetPath(path)) {
      throw error;
    }
    return stat(path);
  }
}

function resolvedMetadata(
  stats: Stats,
  pathKind: AdapterPathKind,
  symlinkTarget?: string,
  options?: FileReadOptions,
): Pick<PathContents, "mode" | "pathKind" | "size" | "symlinkTarget"> {
  return {
    ...(stats.isFile() ? { mode: fileMode(stats) } : {}),
    pathKind,
    ...(options?.maxBytes === undefined || !stats.isFile() ? {} : { size: stats.size }),
    ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
  };
}

/** Permission bits only: the type bits say what `pathKind` already carries. */
function fileMode(stats: Stats): number {
  return stats.mode & 0o777;
}

async function readRegularFile(
  path: string,
  stats: Stats,
  metadata: Pick<PathContents, "mode" | "pathKind" | "size" | "symlinkTarget">,
  options?: FileReadOptions,
): Promise<PathContents> {
  const maxBytes = options?.maxBytes;
  if (maxBytes === undefined && stats.size > MAX_FILE_BYTES) {
    return { ...metadata, exists: true, isDirectory: false, problem: "too-large" };
  }
  try {
    if (maxBytes === undefined) {
      const content = await readFile(path);
      return {
        ...metadata,
        content: content.toString("utf8"),
        exists: true,
        isDirectory: false,
        ...(isUtf8(content) ? {} : { utf8Valid: false }),
      };
    }
    return {
      ...metadata,
      content: await readPrefix(path, Math.min(maxBytes, stats.size)),
      exists: true,
      isDirectory: false,
    };
  } catch (error) {
    return { ...metadata, exists: true, isDirectory: false, problem: toProblem(error) };
  }
}

async function readPrefix(path: string, maxBytes: number): Promise<string> {
  if (maxBytes === 0) {
    return "";
  }
  // An embedded filesystem cannot serve the positional reads below, so the prefix is sliced out of
  // a whole read. Peak memory is the asset's size rather than `maxBytes`, which is acceptable only
  // because an embedded asset is already resident in the executable that is running.
  if (isEmbeddedAssetPath(path)) {
    const buffer = await readFile(path);
    return buffer.subarray(0, maxBytes).toString("utf8");
  }
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

async function readDirectory(
  path: string,
  metadata: Pick<PathContents, "pathKind" | "symlinkTarget">,
): Promise<PathContents> {
  const entries: string[] = [];
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        return { ...metadata, exists: true, isDirectory: true, problem: "too-many-entries" };
      }
      entries.push(entry.name);
    }
  } catch (error) {
    return { ...metadata, exists: true, isDirectory: true, problem: toProblem(error) };
  }
  return { ...metadata, entries: entries.sort(), exists: true, isDirectory: true };
}

export async function resolveRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function toProblem(error: unknown): FileProblem {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM": {
      return "denied";
    }
    case "ELOOP": {
      return "loop";
    }
    case "EMFILE":
    case "ENFILE":
    case "ENOMEM": {
      return "resources";
    }
    case "EISDIR":
    case "ENXIO": {
      return "unsupported";
    }
    default: {
      return "unreadable";
    }
  }
}
