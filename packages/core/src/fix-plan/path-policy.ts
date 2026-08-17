import { isAbsolute, resolve, sep } from "node:path";

import type { FileOperation, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";

import { claimPath, comparablePath, createClaimIndex, detectCaseInsensitive } from "./claims.js";
import { backupRoot } from "./journal-paths.js";
import { runProbes, type AncestorProbe } from "./probe.js";
import { describeRoots, matchRoot, resolveAllowedRoots, type AllowedRoot } from "./roots.js";
import { operationError } from "./types.js";

export interface ValidatedOperation {
  /** Earlier write operation that owns this exact path and will absorb this operation. */
  readonly coalescesWith?: number | undefined;
  readonly index: number;
  readonly operation: FileOperation;
  readonly paths: readonly string[];
}

/** Everything path validation needs that is worth resolving once per plan. */
export interface PathPolicy {
  /** Whether path comparison must ignore case. See {@link detectCaseInsensitive}. */
  readonly caseInsensitive: boolean;
  readonly roots: readonly AllowedRoot[];
  /** Kernel-owned paths that plans may never mutate. */
  readonly reservedRoots: readonly string[];
}

/** Resolves the roots and filesystem traits a plan is validated against. */
export async function createPathPolicy(
  model: WorkspaceModel,
  managedHomeRoots: readonly string[] | undefined,
): Promise<PathPolicy> {
  const workspaceRoot = resolve(model.projectRoot ?? model.cwd);
  return {
    caseInsensitive: await detectCaseInsensitive(workspaceRoot),
    reservedRoots: Object.freeze([backupRoot(model.homeDir)]),
    roots: resolveAllowedRoots(model, managedHomeRoots),
  };
}

/** Validates every path before the executor reads operation state or performs a mutation. */
export async function validatePlanPaths(
  plan: FixPlan,
  policy: PathPolicy,
): Promise<readonly ValidatedOperation[]> {
  const claims = createClaimIndex();
  const operations: ValidatedOperation[] = [];
  const probes: AncestorProbe[] = [];

  // The synchronous checks run first and in plan order, so the operation a caller is told about is
  // always the earliest offending one.
  for (const [index, operation] of plan.operations.entries()) {
    const paths = mutationPaths(operation);
    let coalescesWith: number | undefined;

    for (const path of paths) {
      assertPathShape(path, policy, index);
      const resolvedPath = resolve(path);
      const exactOwner = claims.exact.get(comparablePath(resolvedPath, policy.caseInsensitive));
      // Only a write can be absorbed by an earlier write, and `mutationPaths` gives a write exactly
      // one path, so at most one owner is ever considered for an operation.
      const allowedExactOwner =
        operation.type === "write"
          ? coalescedWriteOwner(resolvedPath, exactOwner, operations)
          : undefined;
      claimPath(claims, path, index, policy.caseInsensitive, allowedExactOwner);
      coalescesWith = allowedExactOwner;
      probes.push({ includeFinalPath: false, operationIndex: index, path });
    }

    collectReferenceProbes(operation, policy, index, probes);

    operations.push({
      ...(coalescesWith === undefined ? {} : { coalescesWith }),
      index,
      operation,
      paths: Object.freeze(paths),
    });
  }

  await runProbes(probes, policy.roots, policy.caseInsensitive);
  return Object.freeze(operations);
}

/**
 * The earlier write that may absorb this one, or undefined when the overlap is a hard conflict.
 *
 * `operations` is pushed once per plan operation in plan order, so an operation's index is also its
 * position.
 */
function coalescedWriteOwner(
  resolvedPath: string,
  exactOwner: number | undefined,
  operations: readonly ValidatedOperation[],
): number | undefined {
  const owner = exactOwner === undefined ? undefined : operations[exactOwner];
  if (owner?.operation.type !== "write") {
    return undefined;
  }
  // The claim key is case-folded whenever `detectCaseInsensitive` cannot decide, and it answers
  // "insensitive" when in doubt. Widening that way stays safe while it only ever raises a conflict;
  // it is not safe for coalescing, where two genuinely distinct files would merge into one write
  // and the second spelling would never reach disk. Merge only literally identical paths.
  return resolve(owner.operation.path) === resolvedPath ? exactOwner : undefined;
}

function collectReferenceProbes(
  operation: FileOperation,
  policy: PathPolicy,
  operationIndex: number,
  probes: AncestorProbe[],
): void {
  if (operation.type === "symlink") {
    assertPathShape(operation.target, policy, operationIndex);
    probes.push({ includeFinalPath: true, operationIndex, path: operation.target });
  }
  if (operation.type === "archive" && operation.replacement?.type === "symlink") {
    assertPathShape(operation.replacement.target, policy, operationIndex);
    probes.push({
      includeFinalPath: true,
      operationIndex,
      path: operation.replacement.target,
    });
  }
}

/** Rechecks ancestors immediately before a mutation to narrow symlink race windows. */
export async function revalidateMutationPath(
  path: string,
  policy: PathPolicy,
  operationIndex: number,
): Promise<void> {
  assertPathShape(path, policy, operationIndex);
  await runProbes(
    [{ includeFinalPath: false, operationIndex, path }],
    policy.roots,
    policy.caseInsensitive,
  );
}

/** Rechecks the complete target path because a symlink target is followed when the link is used. */
export async function revalidateSymlinkTarget(
  path: string,
  policy: PathPolicy,
  operationIndex: number,
): Promise<void> {
  assertPathShape(path, policy, operationIndex);
  await runProbes(
    [{ includeFinalPath: true, operationIndex, path }],
    policy.roots,
    policy.caseInsensitive,
  );
}

/** Every path an operation mutates, in source-plan order. */
export function mutationPaths(operation: FileOperation): string[] {
  switch (operation.type) {
    case "move": {
      return [operation.sourcePath, operation.destinationPath];
    }
    case "archive":
    case "remove":
    case "symlink":
    case "write": {
      return [operation.path];
    }
  }
}

function assertPathShape(path: string, policy: PathPolicy, operationIndex: number): void {
  if (!isAbsolute(path)) {
    throw operationError("invalid-path", operationIndex, `path must be absolute: ${path}`, {
      path,
    });
  }

  if (path.split(/[\\/]/u).includes("..")) {
    throw operationError(
      "invalid-path",
      operationIndex,
      `path must not contain a parent traversal: ${path}`,
      { path },
    );
  }

  if (policy.reservedRoots.some((root) => isWithin(root, path, policy.caseInsensitive))) {
    throw operationError(
      "invalid-path",
      operationIndex,
      `path is reserved for Aura's undo journal: ${path}`,
      { path },
    );
  }

  if (matchRoot(path, policy.roots, policy.caseInsensitive) === undefined) {
    throw operationError(
      "invalid-path",
      operationIndex,
      `path is outside every allowed root: ${path}. Allowed roots: ${describeRoots(policy.roots)}`,
      { path },
    );
  }
}

function isWithin(root: string, candidate: string, caseInsensitive: boolean): boolean {
  const comparableRoot = comparablePath(resolve(root), caseInsensitive);
  const comparableCandidate = comparablePath(resolve(candidate), caseInsensitive);
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(`${comparableRoot}${sep}`)
  );
}
