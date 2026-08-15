import { mkdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { revalidateMutationPath, revalidateSymlinkTarget } from "./path-policy.js";
import { prepareFixPlan, type PreparedFixPlan, type PreparedOperation } from "./prepare.js";
import { inspectPath, statesEqual, type PathState } from "./state.js";
import {
  FixPlanError,
  type FixPlanExecutionOptions,
  type FixPlanExecutionResult,
  type FixPlanPreview,
  type FixPlanPreviewOptions,
} from "./types.js";

/** Validates and renders a plan without mutating the filesystem. */
export async function previewFixPlan(options: FixPlanPreviewOptions): Promise<FixPlanPreview> {
  return (await prepareFixPlan(options)).preview;
}

/** Validates, previews, and optionally applies a plan through the kernel's single write path. */
export async function executeFixPlan(
  options: FixPlanExecutionOptions,
): Promise<FixPlanExecutionResult> {
  const prepared = await prepareFixPlan(options);
  const dryRun = options.dryRun ?? false;

  if (dryRun) {
    return Object.freeze({ appliedOperationCount: 0, dryRun, preview: prepared.preview });
  }

  let appliedOperationCount = 0;
  for (const operation of prepared.operations) {
    if (operation.preview.effect === "noop") {
      continue;
    }

    await applyPreparedOperation(operation, prepared);
    appliedOperationCount += 1;
  }

  return Object.freeze({ appliedOperationCount, dryRun, preview: prepared.preview });
}

/** The only function in the kernel that turns a prepared fix operation into filesystem writes. */
async function applyPreparedOperation(
  prepared: PreparedOperation,
  plan: PreparedFixPlan,
): Promise<void> {
  try {
    switch (prepared.type) {
      case "move": {
        await applyMove(prepared, plan);
        return;
      }
      case "remove": {
        await applyRemove(prepared, plan);
        return;
      }
      case "symlink": {
        await applySymlink(prepared, plan);
        return;
      }
      case "write": {
        await applyWrite(prepared, plan);
        return;
      }
    }
  } catch (error) {
    if (error instanceof FixPlanError) {
      throw error;
    }

    const path = prepared.preview.paths[0];
    const message = error instanceof Error ? error.message : String(error);
    throw new FixPlanError(
      "filesystem-error",
      `could not apply ${prepared.type} operation: ${message}`,
      prepared.preview.index,
      path,
    );
  }
}

type PreparedMove = Extract<PreparedOperation, { readonly type: "move" }>;
type PreparedRemove = Extract<PreparedOperation, { readonly type: "remove" }>;
type PreparedSymlink = Extract<PreparedOperation, { readonly type: "symlink" }>;
type PreparedWrite = Extract<PreparedOperation, { readonly type: "write" }>;

async function applyMove(prepared: PreparedMove, plan: PreparedFixPlan): Promise<void> {
  await verifyPath(
    prepared.operation.sourcePath,
    prepared.sourceBefore,
    prepared.preview.index,
    plan,
  );
  await verifyPath(
    prepared.operation.destinationPath,
    prepared.destinationBefore,
    prepared.preview.index,
    plan,
  );
  await mkdir(dirname(prepared.operation.destinationPath), { recursive: true });
  await rename(prepared.operation.sourcePath, prepared.operation.destinationPath);
}

async function applyRemove(prepared: PreparedRemove, plan: PreparedFixPlan): Promise<void> {
  await verifyPath(prepared.operation.path, prepared.before, prepared.preview.index, plan);
  if (prepared.before.kind === "directory") {
    await rmdir(prepared.operation.path);
  } else {
    await unlink(prepared.operation.path);
  }
}

async function applySymlink(prepared: PreparedSymlink, plan: PreparedFixPlan): Promise<void> {
  await verifyPath(prepared.operation.path, prepared.before, prepared.preview.index, plan);
  await revalidateSymlinkTarget(prepared.operation.target, plan.model, prepared.preview.index);
  await mkdir(dirname(prepared.operation.path), { recursive: true });
  if (prepared.before.kind !== "missing") {
    await unlink(prepared.operation.path);
  }
  await symlink(prepared.operation.target, prepared.operation.path);
}

async function applyWrite(prepared: PreparedWrite, plan: PreparedFixPlan): Promise<void> {
  await verifyPath(prepared.operation.path, prepared.before, prepared.preview.index, plan);
  await mkdir(dirname(prepared.operation.path), { recursive: true });

  if (prepared.before.kind === "file") {
    await writeFile(prepared.operation.path, prepared.operation.content, "utf8");
    return;
  }
  if (prepared.before.kind === "symlink") {
    await unlink(prepared.operation.path);
  }
  await writeFile(prepared.operation.path, prepared.operation.content, {
    encoding: "utf8",
    flag: "wx",
    mode: prepared.operation.mode ?? 0o644,
  });
}

async function verifyPath(
  path: string,
  expected: PathState,
  operationIndex: number,
  plan: PreparedFixPlan,
): Promise<void> {
  await revalidateMutationPath(path, plan.model, operationIndex);
  await assertState(path, expected, operationIndex);
}

async function assertState(
  path: string,
  expected: PathState,
  operationIndex: number,
): Promise<void> {
  const current = await inspectPath(path, operationIndex);
  if (!statesEqual(expected, current)) {
    throw new FixPlanError(
      "filesystem-changed",
      `path changed after its preview was prepared: ${path}`,
      operationIndex,
      path,
    );
  }
}
