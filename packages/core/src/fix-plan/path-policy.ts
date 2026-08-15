import { isAbsolute, resolve } from "node:path";

import type { FileOperation, FixPlan, WorkspaceModel } from "@tryaura/aura-sdk";

import { claimPath, createClaimIndex, detectCaseInsensitive } from "./claims.js";
import { runProbes, type AncestorProbe } from "./probe.js";
import { describeRoots, matchRoot, resolveAllowedRoots, type AllowedRoot } from "./roots.js";
import { operationError } from "./types.js";

export interface ValidatedOperation {
  readonly index: number;
  readonly operation: FileOperation;
  readonly paths: readonly string[];
}

/** Everything path validation needs that is worth resolving once per plan. */
export interface PathPolicy {
  /** Whether path comparison must ignore case. See {@link detectCaseInsensitive}. */
  readonly caseInsensitive: boolean;
  readonly roots: readonly AllowedRoot[];
}

/** Resolves the roots and filesystem traits a plan is validated against. */
export async function createPathPolicy(
  model: WorkspaceModel,
  managedHomeRoots: readonly string[] | undefined,
): Promise<PathPolicy> {
  const workspaceRoot = resolve(model.projectRoot ?? model.cwd);
  return {
    caseInsensitive: await detectCaseInsensitive(workspaceRoot),
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

    for (const path of paths) {
      assertPathShape(path, policy, index);
      claimPath(claims, path, index, policy.caseInsensitive);
      probes.push({ includeFinalPath: false, operationIndex: index, path });
    }

    if (operation.type === "symlink") {
      assertPathShape(operation.target, policy, index);
      probes.push({ includeFinalPath: true, operationIndex: index, path: operation.target });
    }

    operations.push({ index, operation, paths: Object.freeze(paths) });
  }

  await runProbes(probes, policy.roots, policy.caseInsensitive);
  return Object.freeze(operations);
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

  if (matchRoot(path, policy.roots, policy.caseInsensitive) === undefined) {
    throw operationError(
      "invalid-path",
      operationIndex,
      `path is outside every allowed root: ${path}. Allowed roots: ${describeRoots(policy.roots)}`,
      { path },
    );
  }
}
