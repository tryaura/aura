import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { FileOperation, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";

import { FixPlanError } from "./types.js";

export interface ValidatedOperation {
  readonly index: number;
  readonly operation: FileOperation;
  readonly paths: readonly string[];
}

interface ClaimedPath {
  readonly index: number;
  readonly path: string;
}

/** Validates every path before the executor reads operation state or performs a mutation. */
export async function validatePlanPaths(
  plan: FixPlan,
  model: WorkspaceModel,
): Promise<readonly ValidatedOperation[]> {
  const roots = allowedRoots(model);
  const claimed: ClaimedPath[] = [];
  const operations: ValidatedOperation[] = [];

  for (const [index, operation] of plan.operations.entries()) {
    const paths = mutationPaths(operation);

    for (const path of paths) {
      await validatePath(path, roots, index, false);
      assertUnclaimed(path, index, claimed);
      claimed.push({ index, path: resolve(path) });
    }

    if (operation.type === "symlink") {
      await validatePath(operation.target, roots, index, true);
    }

    operations.push({ index, operation, paths: Object.freeze(paths) });
  }

  return Object.freeze(operations);
}

/** Rechecks ancestors immediately before a mutation to narrow symlink race windows. */
export async function revalidateMutationPath(
  path: string,
  model: WorkspaceModel,
  operationIndex: number,
): Promise<void> {
  await validatePath(path, allowedRoots(model), operationIndex, false);
}

/** Rechecks the complete target path because a symlink target is followed when the link is used. */
export async function revalidateSymlinkTarget(
  path: string,
  model: WorkspaceModel,
  operationIndex: number,
): Promise<void> {
  await validatePath(path, allowedRoots(model), operationIndex, true);
}

function allowedRoots(model: WorkspaceModel): readonly string[] {
  return Object.freeze([resolve(model.projectRoot ?? model.cwd), resolve(model.homeDir, "agents")]);
}

function mutationPaths(operation: FileOperation): string[] {
  switch (operation.type) {
    case "move": {
      return [operation.sourcePath, operation.destinationPath];
    }
    case "remove":
    case "symlink":
    case "write": {
      return [operation.path];
    }
  }
}

async function validatePath(
  path: string,
  roots: readonly string[],
  operationIndex: number,
  includeFinalPath: boolean,
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new FixPlanError("invalid-path", `path must be absolute: ${path}`, operationIndex, path);
  }

  if (path.split(/[\\/]/u).includes("..")) {
    throw new FixPlanError(
      "invalid-path",
      `path must not contain a parent traversal: ${path}`,
      operationIndex,
      path,
    );
  }

  const resolvedPath = resolve(path);
  const root = roots
    .filter((candidate) => isDescendant(candidate, resolvedPath))
    .sort((left, right) => right.length - left.length)[0];

  if (root === undefined) {
    throw new FixPlanError(
      "invalid-path",
      `path is outside the workspace and managed home roots: ${path}`,
      operationIndex,
      path,
    );
  }

  await assertNoIntermediateSymlink(
    root,
    includeFinalPath ? resolvedPath : dirname(resolvedPath),
    operationIndex,
    includeFinalPath,
  );
}

function isDescendant(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function assertNoIntermediateSymlink(
  root: string,
  destination: string,
  operationIndex: number,
  finalMayBeNonDirectory: boolean,
): Promise<void> {
  if (!(await assertUsableRoot(root, operationIndex))) {
    return;
  }

  const difference = relative(root, destination);
  if (difference.length === 0) {
    return;
  }

  const parts = difference.split(sep);
  let current = root;

  for (const [partIndex, part] of parts.entries()) {
    current = join(current, part);
    const kind = await readPathKind(current, operationIndex);
    if (kind === "missing") {
      return;
    }
    if (kind === "symlink") {
      throw new FixPlanError(
        "invalid-path",
        `path traverses a symbolic link: ${current}`,
        operationIndex,
        current,
      );
    }

    const isFinal = partIndex === parts.length - 1;
    if ((!isFinal || !finalMayBeNonDirectory) && kind !== "directory") {
      throw new FixPlanError(
        "path-conflict",
        `path ancestor is not a directory: ${current}`,
        operationIndex,
        current,
      );
    }
  }
}

/** Returns false when the managed root does not exist yet and may safely be created. */
async function assertUsableRoot(root: string, operationIndex: number): Promise<boolean> {
  const rootKind = await readPathKind(root, operationIndex);
  if (rootKind === "missing") {
    return false;
  }
  if (rootKind === "symlink") {
    throw new FixPlanError(
      "invalid-path",
      `allowed root is a symbolic link: ${root}`,
      operationIndex,
      root,
    );
  }
  if (rootKind !== "directory") {
    throw new FixPlanError(
      "path-conflict",
      `allowed root is not a directory: ${root}`,
      operationIndex,
      root,
    );
  }
  return true;
}

async function readPathKind(
  path: string,
  operationIndex: number,
): Promise<"directory" | "missing" | "other" | "symlink"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    return stats.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw new FixPlanError(
      "filesystem-error",
      `could not inspect path ancestor ${path}: ${errorMessage(error)}`,
      operationIndex,
      path,
    );
  }
}

function assertUnclaimed(path: string, index: number, claimed: readonly ClaimedPath[]): void {
  const resolvedPath = resolve(path);
  const conflict = claimed.find(
    (entry) =>
      entry.path === resolvedPath ||
      isDescendant(entry.path, resolvedPath) ||
      isDescendant(resolvedPath, entry.path),
  );

  if (conflict !== undefined) {
    throw new FixPlanError(
      "path-conflict",
      `path overlaps operation ${conflict.index}: ${path}`,
      index,
      path,
    );
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
