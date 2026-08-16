import { Buffer } from "node:buffer";

import type {
  MovePathOperation,
  RemovePathOperation,
  SymlinkOperation,
  WriteFileOperation,
} from "@tryaura/aura-sdk";

import { captureBefore, findUnwritablePath, spendBudget, type RetentionBudget } from "./capture.js";
import { renderMoveDiff, renderRemoveDiff, renderSymlinkDiff, renderWriteDiff } from "./diff.js";
import { FILE_MODES, MAX_MUTABLE_FILE_BYTES, MAX_RETAINED_PLAN_BYTES } from "./limits.js";
import { createPathPolicy, validatePlanPaths, type ValidatedOperation } from "./path-policy.js";
import { prepareArchive } from "./prepare-archive.js";
import { createEnforcedModes, resolveWriteMode, type EnforcedModes } from "./prepare-modes.js";
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
  const enforcedMode = createEnforcedModes(options.model.homeDir, policy.caseInsensitive);
  const readOnly = manifestConflict(options.model);

  // Sequential on purpose: the retention budget is spent in plan order, so what a plan costs in
  // memory does not depend on how its reads happen to interleave.
  for (const operation of validated) {
    operations.push(
      readOnly === undefined
        ? await prepareOperation(operation, budget, enforcedMode)
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
    state: Object.freeze({ model: options.model, operations: Object.freeze(operations), policy }),
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
      return prepareRemove(operation.operation, operation, budget);
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

/** Why a write is refused before its target is read, or undefined when nothing rules it out. */
function writeRejection(operation: WriteFileOperation, content: Buffer): string | undefined {
  if (content.byteLength > MAX_MUTABLE_FILE_BYTES) {
    return `content is ${content.byteLength} bytes, above the ${MAX_MUTABLE_FILE_BYTES} byte limit for one operation`;
  }
  // `FileMode` closes this set at compile time, but plugins ship compiled, and the value reaches
  // `chmod` unchanged. Checking it is what keeps a plan from asking for setuid or world-writable.
  if (operation.mode !== undefined && !FILE_MODES.has(operation.mode)) {
    return `mode 0o${operation.mode.toString(8)} is not a permitted file mode`;
  }

  return undefined;
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
