import type { Stats } from "node:fs";
import { lstat, opendir, readFile, readlink } from "node:fs/promises";

import { errorCode, errorMessage } from "../values.js";
import { FixPlanError, operationError } from "./types.js";

export interface MissingPathState {
  readonly kind: "missing";
}

export interface FilePathState {
  /** Absent when the file is larger than the caller was willing to retain. */
  readonly content?: Buffer | undefined;
  readonly kind: "file";
  readonly mode: number;
  readonly modifiedTimeMs: number;
  readonly size: number;
}

/**
 * A file whose contents were captured.
 *
 * Only these may be written over or removed: a mutation Aura cannot reverse is one it should not
 * start, and the captured buffer is what rollback restores.
 */
export interface CapturedFileState extends FilePathState {
  readonly content: Buffer;
}

export interface DirectoryPathState {
  readonly empty: boolean;
  readonly kind: "directory";
  readonly mode: number;
  readonly modifiedTimeMs: number;
}

export interface SymlinkPathState {
  readonly kind: "symlink";
  readonly target: string;
}

/** A socket, device, or FIFO. Reported rather than thrown so a preview can explain it. */
interface UnsupportedPathState {
  readonly kind: "unsupported";
}

export type PathState =
  | DirectoryPathState
  | FilePathState
  | MissingPathState
  | SymlinkPathState
  | UnsupportedPathState;

const MISSING: MissingPathState = Object.freeze({ kind: "missing" });
const UNSUPPORTED: UnsupportedPathState = Object.freeze({ kind: "unsupported" });

/**
 * Reads the path itself without following a final symbolic link.
 *
 * Contents are captured only up to `maxContentBytes`; pass zero for a path whose contents neither
 * the preview nor rollback needs, such as either end of a rename.
 */
export async function inspectPath(
  path: string,
  operationIndex: number,
  maxContentBytes: number,
): Promise<PathState> {
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
    if (stats.size <= maxContentBytes) {
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

  return UNSUPPORTED;
}

/** Narrows to a file whose contents were captured and can therefore be restored. */
export function isCapturedFile(state: PathState): state is CapturedFileState {
  return state.kind === "file" && state.content !== undefined;
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
      // Only reached for a rename, where contents were deliberately not read and are not part of
      // what the preview promised. Every content-bearing mutation captures both sides.
      return left.modifiedTimeMs === right.modifiedTimeMs;
    }
    case "missing":
    case "unsupported": {
      return true;
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
  return operationError(
    "filesystem-error",
    operationIndex,
    `could not ${action} ${path}: ${errorMessage(error)}`,
    { cause: error, path },
  );
}
