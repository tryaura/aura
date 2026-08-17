import { Buffer } from "node:buffer";
import { resolve } from "node:path";

import type { MovePathOperation, SymlinkOperation, WriteFileOperation } from "@tryaura/aura-sdk";

import { captureBefore, findUnwritablePath, spendBudget, type RetentionBudget } from "./capture.js";
import { renderMoveDiff, renderSymlinkDiff, renderWriteDiff } from "./diff.js";
import { MAX_RETAINED_PLAN_BYTES } from "./limits.js";
import { comparablePath } from "./claims.js";
import { createPathPolicy, validatePlanPaths, type ValidatedOperation } from "./path-policy.js";
import { prepareArchive } from "./prepare-archive.js";
import { createEnforcedModes, resolveWriteMode, type EnforcedModes } from "./prepare-modes.js";
import { prepareRemove } from "./prepare-remove.js";
import { prepareWriteGroup } from "./prepare-write-group.js";
import {
  conflict,
  createPreview,
  noop,
  type PreparedOperation,
  type PreparedPlanState,
} from "./prepared.js";
import { inspectPath, isCapturedFile } from "./state.js";
import type { FixPlanPreview, FixPlanPreviewOptions } from "./types.js";
import { writeRejection } from "./write-validation.js";

// fallow-ignore-next-line complexity -- coordinates preparation across the closed operation union.
export async function prepareOperations(
  options: FixPlanPreviewOptions,
): Promise<{ readonly preview: FixPlanPreview; readonly state: PreparedPlanState }> {
  const policy = await createPathPolicy(options.model, options.managedHomeRoots);
  const validated = await validatePlanPaths(options.plan, policy);
  const budget: RetentionBudget = { remaining: MAX_RETAINED_PLAN_BYTES };
  const operations: PreparedOperation[] = [];
  const enforcedMode = createEnforcedModes(options.model.homeDir, policy.caseInsensitive);
  const readOnly = manifestConflict(options.model);
  const removeClaims = new Map<string, number>();
  for (const operation of validated) {
    if (operation.operation.type === "remove") {
      removeClaims.set(
        comparablePath(resolve(operation.operation.path), policy.caseInsensitive),
        operation.index,
      );
    }
  }
  const operationOwners = options.plan.operations.map((_operation, index) => index);
  const followers = new Map<number, ValidatedOperation[]>();
  for (const operation of validated) {
    if (operation.coalescesWith === undefined) {
      continue;
    }
    operationOwners[operation.index] = operation.coalescesWith;
    const group = followers.get(operation.coalescesWith);
    if (group === undefined) {
      followers.set(operation.coalescesWith, [operation]);
    } else {
      group.push(operation);
    }
  }

  // Sequential on purpose: the retention budget is spent in plan order, so what a plan costs in
  // memory does not depend on how its reads happen to interleave.
  for (const operation of validated) {
    if (operation.coalescesWith !== undefined) {
      continue;
    }
    // Only a write ever collects followers, so a group of one is always the ordinary path.
    const group = followers.get(operation.index);
    operations.push(
      readOnly === undefined
        ? group === undefined
          ? await prepareOperation(
              operation,
              budget,
              enforcedMode,
              removeClaims,
              policy.caseInsensitive,
            )
          : await prepareWriteGroup([operation, ...group], budget, enforcedMode)
        : conflict(operation, readOnly),
    );
  }

  const previews = Object.freeze(operations.map((operation) => operation.preview));
  const preview: FixPlanPreview = Object.freeze({
    changedOperationCount: previews.filter(
      (operation) => operation.effect !== "noop" && operation.effect !== "conflict",
    ).length,
    conflictedOperationCount: previews.filter((operation) => operation.effect === "conflict")
      .length,
    manualSteps: Object.freeze([...(options.plan.manualSteps ?? [])]),
    operations: previews,
    summary: options.plan.summary,
  });

  return {
    preview,
    state: Object.freeze({
      model: options.model,
      operationOwners: Object.freeze(operationOwners),
      operations: Object.freeze(operations),
      policy,
    }),
  };
}

/**
 * Blocks every operation while desired state is unreadable, with the reason on each one.
 *
 * Applying a fix records what Aura now owns. If that ledger cannot be read it cannot be updated
 * either, and a converge that writes files it then forgets about is worse than one that does not
 * run. Reported as a per-operation conflict so the preview a user confirms says so up front, rather
 * than looking applicable and failing at the last step.
 */
function manifestConflict(model: FixPlanPreviewOptions["model"]): string | undefined {
  if (model.manifest.status !== "read-only") {
    return undefined;
  }
  return model.manifest.problem.message.replace(/\.$/u, "");
}

async function prepareOperation(
  operation: ValidatedOperation,
  budget: RetentionBudget,
  enforcedMode: EnforcedModes,
  removeClaims: ReadonlyMap<string, number>,
  caseInsensitive: boolean,
): Promise<PreparedOperation> {
  const blocked = await findUnwritablePath(operation);
  if (blocked !== undefined) {
    return conflict(operation, blocked);
  }

  switch (operation.operation.type) {
    case "archive": {
      return prepareArchive(operation.operation, operation, budget, enforcedMode);
    }
    case "move": {
      return prepareMove(operation.operation, operation);
    }
    case "remove": {
      return prepareRemove(operation.operation, operation, budget, removeClaims, caseInsensitive);
    }
    case "symlink": {
      return prepareSymlink(operation.operation, operation, budget);
    }
    case "write": {
      return prepareWrite(operation.operation, operation, budget, enforcedMode);
    }
  }
}

async function prepareWrite(
  operation: WriteFileOperation,
  validated: ValidatedOperation,
  budget: RetentionBudget,
  enforcedMode: EnforcedModes,
): Promise<PreparedOperation> {
  const content = Buffer.from(operation.content, "utf8");
  const rejected = writeRejection(operation, content);
  if (rejected !== undefined) {
    return conflict(validated, rejected);
  }

  const captured = await captureBefore(validated, operation.path, budget, "written over");
  if ("conflict" in captured) {
    return conflict(validated, captured.conflict);
  }

  const before = captured.state;
  if (before.kind === "directory") {
    return conflict(validated, "cannot replace a directory with a file");
  }

  const mode = resolveWriteMode(operation, before, enforcedMode);
  if (isCapturedFile(before) && before.content.equals(content) && before.mode === mode) {
    return noop(validated);
  }

  spendBudget(budget, before);
  return {
    before,
    mode,
    operation,
    preview: createPreview(
      validated,
      before.kind === "missing" ? "create" : "update",
      renderWriteDiff(operation.path, before, operation.content, operation.mode, mode),
    ),
    type: "write",
  };
}

async function prepareMove(
  operation: MovePathOperation,
  validated: ValidatedOperation,
): Promise<PreparedOperation> {
  // A rename neither shows contents nor restores them, so neither end is read.
  const sourceBefore = await inspectPath(operation.sourcePath, validated.index, 0);
  const destinationBefore = await inspectPath(operation.destinationPath, validated.index, 0);

  if (sourceBefore.kind === "missing") {
    return destinationBefore.kind === "missing"
      ? conflict(validated, "move source and destination are both missing")
      : noop(validated);
  }
  if (sourceBefore.kind === "symlink" || sourceBefore.kind === "unsupported") {
    return conflict(validated, "move source must be a file or directory");
  }
  if (destinationBefore.kind !== "missing") {
    return conflict(validated, "move destination already exists");
  }

  return {
    destinationBefore,
    operation,
    preview: createPreview(
      validated,
      "move",
      renderMoveDiff(operation.sourcePath, operation.destinationPath),
    ),
    sourceBefore,
    type: "move",
  };
}

async function prepareSymlink(
  operation: SymlinkOperation,
  validated: ValidatedOperation,
  budget: RetentionBudget,
): Promise<PreparedOperation> {
  const captured = await captureBefore(
    validated,
    operation.path,
    budget,
    "replaced with a symbolic link",
  );
  if ("conflict" in captured) {
    return conflict(validated, captured.conflict);
  }

  const before = captured.state;
  if (before.kind === "directory") {
    return conflict(validated, "cannot replace a directory with a symbolic link");
  }
  if (before.kind === "symlink" && before.target === operation.target) {
    return noop(validated);
  }

  spendBudget(budget, before);
  return {
    before,
    operation,
    preview: createPreview(
      validated,
      "symlink",
      renderSymlinkDiff(operation.path, before, operation.target),
    ),
    type: "symlink",
  };
}
