import { Buffer } from "node:buffer";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DEFAULT_FILE_MODE } from "./limits.js";
import type { StoredOperation, StoredPathState } from "./journal-schema.js";
import type { ApplicableOperation } from "./prepared.js";
import type {
  CapturedFileState,
  DirectoryPathState,
  FilePathState,
  MissingPathState,
  PathState,
  SymlinkPathState,
} from "./state.js";
import { errorCode, FixPlanError } from "./types.js";

export async function storeOperation(
  operation: ApplicableOperation,
  directory: string,
): Promise<StoredOperation> {
  const createdDirectory = await firstMissingDirectory(parentCreatedBy(operation));
  switch (operation.type) {
    case "move": {
      return {
        createdDirectory,
        destinationPath: operation.operation.destinationPath,
        index: operation.preview.index,
        sourceBefore: storedState(operation.sourceBefore),
        sourcePath: operation.operation.sourcePath,
        type: "move",
      };
    }
    case "remove": {
      return {
        before: await storedStateWithPayload(
          operation.before,
          directory,
          operation.preview.index,
          "before",
        ),
        index: operation.preview.index,
        path: operation.operation.path,
        type: "remove",
      };
    }
    case "symlink": {
      return {
        before: await storedStateWithPayload(
          operation.before,
          directory,
          operation.preview.index,
          "before",
        ),
        createdDirectory,
        index: operation.preview.index,
        path: operation.operation.path,
        target: operation.operation.target,
        type: "symlink",
      };
    }
    case "write": {
      const content = Buffer.from(operation.operation.content, "utf8");
      const mode =
        operation.before.kind === "file"
          ? operation.before.mode
          : (operation.operation.mode ?? DEFAULT_FILE_MODE);
      return {
        after: await storeFile(content, mode, directory, operation.preview.index, "after"),
        before: await storedStateWithPayload(
          operation.before,
          directory,
          operation.preview.index,
          "before",
        ),
        createdDirectory,
        index: operation.preview.index,
        path: operation.operation.path,
        type: "write",
      };
    }
  }
}

function parentCreatedBy(operation: ApplicableOperation): string | undefined {
  switch (operation.type) {
    case "move": {
      return dirname(operation.operation.destinationPath);
    }
    case "symlink":
    case "write": {
      return dirname(operation.operation.path);
    }
    case "remove": {
      return undefined;
    }
  }
}

async function firstMissingDirectory(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) {
    return undefined;
  }
  let current = path;
  let first: string | undefined;
  while (true) {
    try {
      await lstat(current);
      return first;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      first = current;
      const parent = dirname(current);
      if (parent === current) {
        return first;
      }
      current = parent;
    }
  }
}

function storedStateWithPayload(
  state: CapturedFileState | MissingPathState | SymlinkPathState,
  directory: string,
  index: number,
  label: string,
): Promise<Extract<StoredPathState, { readonly kind: "file" | "missing" | "symlink" }>>;
function storedStateWithPayload(
  state: CapturedFileState | DirectoryPathState | SymlinkPathState,
  directory: string,
  index: number,
  label: string,
): Promise<Extract<StoredPathState, { readonly kind: "directory" | "file" | "symlink" }>>;
async function storedStateWithPayload(
  state: PathState,
  directory: string,
  index: number,
  label: string,
): Promise<StoredPathState> {
  if (state.kind === "file") {
    if (state.content === undefined) {
      throw new FixPlanError("backup-error", "reversible file state has no captured contents");
    }
    return storeFile(state.content, state.mode, directory, index, label, state.modifiedTimeMs);
  }
  return storedState(state);
}

function storedState(
  state: DirectoryPathState | FilePathState,
): Extract<StoredPathState, { readonly kind: "directory" | "file" }>;
function storedState(state: PathState): StoredPathState;
function storedState(state: PathState): StoredPathState {
  switch (state.kind) {
    case "directory":
    case "symlink": {
      return { ...state };
    }
    case "file": {
      return {
        kind: "file",
        mode: state.mode,
        modifiedTimeMs: state.modifiedTimeMs,
        size: state.size,
      };
    }
    case "missing": {
      return { kind: "missing" };
    }
    case "unsupported": {
      throw new FixPlanError("backup-error", "cannot store an unsupported path state");
    }
  }
}

async function storeFile(
  content: Buffer,
  mode: number,
  directory: string,
  index: number,
  label: string,
  modifiedTimeMs?: number,
): Promise<StoredPathState & { readonly kind: "file" }> {
  const payload = join("files", `${String(index)}-${label}.bin`);
  const path = join(directory, payload);
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return {
    kind: "file",
    mode,
    modifiedTimeMs: modifiedTimeMs ?? 0,
    payload,
    size: content.byteLength,
  };
}
