import { Buffer } from "node:buffer";

import type {
  MovePathOperation,
  RemovePathOperation,
  SymlinkOperation,
  WriteFileOperation,
} from "@tryaura/aura-sdk";

import { captureBefore, findUnwritablePath, spendBudget, type RetentionBudget } from "./capture.js";
import { renderMoveDiff, renderRemoveDiff, renderSymlinkDiff, renderWriteDiff } from "./diff.js";
import { MAX_MUTABLE_FILE_BYTES, MAX_RETAINED_PLAN_BYTES } from "./limits.js";
import { createPathPolicy, validatePlanPaths, type ValidatedOperation } from "./path-policy.js";
import {
  conflict,
  createPreview,
  noop,
  type PreparedOperation,
  type PreparedPlanState,
} from "./prepared.js";
import { inspectPath, isCapturedFile } from "./state.js";
import type { FixPlanPreview, FixPlanPreviewOptions } from "./types.js";

export async function prepareOperations(
  options: FixPlanPreviewOptions,
): Promise<{ readonly preview: FixPlanPreview; readonly state: PreparedPlanState }> {
  const policy = await createPathPolicy(options.model, options.managedHomeRoots);
  const validated = await validatePlanPaths(options.plan, policy);
  const budget: RetentionBudget = { remaining: MAX_RETAINED_PLAN_BYTES };
  const operations: PreparedOperation[] = [];

  // Sequential on purpose: the retention budget is spent in plan order, so what a plan costs in
  // memory does not depend on how its reads happen to interleave.
  for (const operation of validated) {
    operations.push(await prepareOperation(operation, budget));
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
    state: Object.freeze({ model: options.model, operations: Object.freeze(operations), policy }),
  };
}

async function prepareOperation(
  operation: ValidatedOperation,
  budget: RetentionBudget,
): Promise<PreparedOperation> {
  const blocked = await findUnwritablePath(operation);
  if (blocked !== undefined) {
    return conflict(operation, blocked);
  }

  switch (operation.operation.type) {
    case "move": {
      return prepareMove(operation.operation, operation);
    }
    case "remove": {
      return prepareRemove(operation.operation, operation, budget);
    }
    case "symlink": {
      return prepareSymlink(operation.operation, operation, budget);
    }
    case "write": {
      return prepareWrite(operation.operation, operation, budget);
    }
  }
}

async function prepareWrite(
  operation: WriteFileOperation,
  validated: ValidatedOperation,
  budget: RetentionBudget,
): Promise<PreparedOperation> {
  const content = Buffer.from(operation.content, "utf8");
  if (content.byteLength > MAX_MUTABLE_FILE_BYTES) {
    return conflict(
      validated,
      `content is ${content.byteLength} bytes, above the ${MAX_MUTABLE_FILE_BYTES} byte limit for one operation`,
    );
  }

  const captured = await captureBefore(validated, operation.path, budget, "written over");
  if ("conflict" in captured) {
    return conflict(validated, captured.conflict);
  }

  const before = captured.state;
  if (before.kind === "directory") {
    return conflict(validated, "cannot replace a directory with a file");
  }
  if (isCapturedFile(before) && before.content.equals(content)) {
    return noop(validated);
  }

  spendBudget(budget, before);
  return {
    before,
    operation,
    preview: createPreview(
      validated,
      before.kind === "missing" ? "create" : "update",
      renderWriteDiff(operation.path, before, operation.content, operation.mode),
    ),
    type: "write",
  };
}

async function prepareRemove(
  operation: RemovePathOperation,
  validated: ValidatedOperation,
  budget: RetentionBudget,
): Promise<PreparedOperation> {
  const captured = await captureBefore(validated, operation.path, budget, "removed");
  if ("conflict" in captured) {
    return conflict(validated, captured.conflict);
  }

  const before = captured.state;
  if (before.kind === "missing") {
    return noop(validated);
  }
  if (before.kind === "directory" && !before.empty) {
    return conflict(validated, "remove accepts only an empty directory");
  }

  spendBudget(budget, before);
  return {
    before,
    operation,
    preview: createPreview(validated, "remove", renderRemoveDiff(operation.path, before)),
    type: "remove",
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
