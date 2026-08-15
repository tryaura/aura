import type { Stats } from "node:fs";
import { lstat, opendir, readFile, readlink } from "node:fs/promises";

import { MAX_FILE_BYTES } from "../workspace/reader.js";
import { FixPlanError } from "./types.js";

interface MissingPathState {
  readonly kind: "missing";
}

interface FilePathState {
  readonly content?: Buffer | undefined;
  readonly kind: "file";
  readonly mode: number;
  readonly modifiedTimeMs: number;
  readonly size: number;
}

interface DirectoryPathState {
  readonly empty: boolean;
  readonly kind: "directory";
  readonly mode: number;
  readonly modifiedTimeMs: number;
}

interface SymlinkPathState {
  readonly kind: "symlink";
  readonly target: string;
}

export type PathState = DirectoryPathState | FilePathState | MissingPathState | SymlinkPathState;

const MISSING: MissingPathState = Object.freeze({ kind: "missing" });

/** Reads the path itself without following a final symbolic link. */
export async function inspectPath(path: string, operationIndex: number): Promise<PathState> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return MISSING;
    }
    throw filesystemError(path, operationIndex, "inspect", error);
  }

  if (stats.isSymbolicLink()) {
    try {
      return { kind: "symlink", target: await readlink(path) };
    } catch (error) {
      throw filesystemError(path, operationIndex, "read symbolic link", error);
    }
  }

  if (stats.isFile()) {
    let content: Buffer | undefined;
    if (stats.size <= MAX_FILE_BYTES) {
      try {
        content = await readFile(path);
      } catch (error) {
        throw filesystemError(path, operationIndex, "read", error);
      }
    }

    return {
      content,
      kind: "file",
      mode: stats.mode & 0o777,
      modifiedTimeMs: stats.mtimeMs,
      size: stats.size,
    };
  }

  if (stats.isDirectory()) {
    return {
      empty: await isDirectoryEmpty(path, operationIndex),
      kind: "directory",
      mode: stats.mode & 0o777,
      modifiedTimeMs: stats.mtimeMs,
    };
  }

  throw new FixPlanError(
    "unsupported-path",
    `path is not a regular file, directory, or symbolic link: ${path}`,
    operationIndex,
    path,
  );
}

export function statesEqual(left: PathState, right: PathState): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "directory": {
      return (
        right.kind === "directory" &&
        left.empty === right.empty &&
        left.mode === right.mode &&
        left.modifiedTimeMs === right.modifiedTimeMs
      );
    }
    case "file": {
      if (right.kind !== "file" || left.mode !== right.mode || left.size !== right.size) {
        return false;
      }
      if (left.content !== undefined && right.content !== undefined) {
        return left.content.equals(right.content);
      }
      return left.modifiedTimeMs === right.modifiedTimeMs;
    }
    case "missing": {
      return right.kind === "missing";
    }
    case "symlink": {
      return right.kind === "symlink" && left.target === right.target;
    }
  }
}

async function isDirectoryEmpty(path: string, operationIndex: number): Promise<boolean> {
  try {
    const directory = await opendir(path);
    try {
      const entry = await directory.read();
      return entry === null;
    } finally {
      await directory.close();
    }
  } catch (error) {
    throw filesystemError(path, operationIndex, "read directory", error);
  }
}

function filesystemError(
  path: string,
  operationIndex: number,
  action: string,
  error: unknown,
): FixPlanError {
  const message = error instanceof Error ? error.message : String(error);
  return new FixPlanError(
    "filesystem-error",
    `could not ${action} ${path}: ${message}`,
    operationIndex,
    path,
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
