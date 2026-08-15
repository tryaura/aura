import { Buffer } from "node:buffer";

import type {
  MovePathOperation,
  RemovePathOperation,
  SymlinkOperation,
  WorkspaceModel,
  WriteFileOperation,
} from "@tryaura/aura-sdk";

import { renderMoveDiff, renderRemoveDiff, renderSymlinkDiff, renderWriteDiff } from "./diff.js";
import { validatePlanPaths, type ValidatedOperation } from "./path-policy.js";
import { inspectPath, type PathState } from "./state.js";
import {
  FixPlanError,
  type FixOperationEffect,
  type FixOperationPreview,
  type FixPlanPreview,
  type FixPlanPreviewOptions,
} from "./types.js";

interface PreparedBase {
  readonly preview: FixOperationPreview;
}

interface PreparedWriteOperation extends PreparedBase {
  readonly before: PathState;
  readonly operation: WriteFileOperation;
  readonly type: "write";
}

interface PreparedRemoveOperation extends PreparedBase {
  readonly before: PathState;
  readonly operation: RemovePathOperation;
  readonly type: "remove";
}

interface PreparedMoveOperation extends PreparedBase {
  readonly destinationBefore: PathState;
  readonly operation: MovePathOperation;
  readonly sourceBefore: PathState;
  readonly type: "move";
}

interface PreparedSymlinkOperation extends PreparedBase {
  readonly before: PathState;
  readonly operation: SymlinkOperation;
  readonly type: "symlink";
}

export type PreparedOperation =
  | PreparedMoveOperation
  | PreparedRemoveOperation
  | PreparedSymlinkOperation
  | PreparedWriteOperation;

export interface PreparedFixPlan {
  readonly model: WorkspaceModel;
  readonly operations: readonly PreparedOperation[];
  readonly preview: FixPlanPreview;
}

export async function prepareFixPlan(options: FixPlanPreviewOptions): Promise<PreparedFixPlan> {
  const validated = await validatePlanPaths(options.plan, options.model);
  const operations: PreparedOperation[] = [];

  for (const operation of validated) {
    operations.push(await prepareOperation(operation));
  }

  const previews = Object.freeze(operations.map((operation) => operation.preview));
  const preview: FixPlanPreview = Object.freeze({
    changedOperationCount: previews.filter((operation) => operation.effect !== "noop").length,
    manualSteps: Object.freeze([...(options.plan.manualSteps ?? [])]),
    operations: previews,
    summary: options.plan.summary,
  });

  return Object.freeze({ model: options.model, operations: Object.freeze(operations), preview });
}

async function prepareOperation(operation: ValidatedOperation): Promise<PreparedOperation> {
  switch (operation.operation.type) {
    case "move": {
      return prepareMove(operation.operation, operation);
    }
    case "remove": {
      return prepareRemove(operation.operation, operation);
    }
    case "symlink": {
      return prepareSymlink(operation.operation, operation);
    }
    case "write": {
      return prepareWrite(operation.operation, operation);
    }
  }
}

async function prepareWrite(
  operation: WriteFileOperation,
  validated: ValidatedOperation,
): Promise<PreparedWriteOperation> {
  const before = await inspectPath(operation.path, validated.index);
  if (before.kind === "directory") {
    throw conflict(validated, operation.path, "cannot replace a directory with a file");
  }

  const content = Buffer.from(operation.content, "utf8");
  const unchanged = before.kind === "file" && before.content?.equals(content) === true;
  const effect: FixOperationEffect = unchanged
    ? "noop"
    : before.kind === "missing"
      ? "create"
      : "update";

  return {
    before,
    operation,
    preview: createPreview(
      validated,
      effect,
      effect === "noop" ? "" : renderWriteDiff(operation.path, before, operation.content),
    ),
    type: "write",
  };
}

async function prepareRemove(
  operation: RemovePathOperation,
  validated: ValidatedOperation,
): Promise<PreparedRemoveOperation> {
  const before = await inspectPath(operation.path, validated.index);
  if (before.kind === "directory" && !before.empty) {
    throw conflict(validated, operation.path, "remove accepts only an empty directory");
  }

  const effect: FixOperationEffect = before.kind === "missing" ? "noop" : "remove";
  return {
    before,
    operation,
    preview: createPreview(
      validated,
      effect,
      effect === "noop" ? "" : renderRemoveDiff(operation.path, before),
    ),
    type: "remove",
  };
}

async function prepareMove(
  operation: MovePathOperation,
  validated: ValidatedOperation,
): Promise<PreparedMoveOperation> {
  const sourceBefore = await inspectPath(operation.sourcePath, validated.index);
  const destinationBefore = await inspectPath(operation.destinationPath, validated.index);

  if (sourceBefore.kind === "missing") {
    if (destinationBefore.kind === "missing") {
      throw conflict(
        validated,
        operation.sourcePath,
        "move source and destination are both missing",
      );
    }
    return {
      destinationBefore,
      operation,
      preview: createPreview(validated, "noop", ""),
      sourceBefore,
      type: "move",
    };
  }

  if (sourceBefore.kind === "symlink") {
    throw new FixPlanError(
      "unsupported-path",
      `move source must be a file or directory: ${operation.sourcePath}`,
      validated.index,
      operation.sourcePath,
    );
  }
  if (destinationBefore.kind !== "missing") {
    throw conflict(validated, operation.destinationPath, "move destination already exists");
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
): Promise<PreparedSymlinkOperation> {
  const before = await inspectPath(operation.path, validated.index);
  if (before.kind === "directory") {
    throw conflict(validated, operation.path, "cannot replace a directory with a symbolic link");
  }

  const unchanged = before.kind === "symlink" && before.target === operation.target;
  return {
    before,
    operation,
    preview: createPreview(
      validated,
      unchanged ? "noop" : "symlink",
      unchanged ? "" : renderSymlinkDiff(operation.path, before, operation.target),
    ),
    type: "symlink",
  };
}

function createPreview(
  operation: ValidatedOperation,
  effect: FixOperationEffect,
  diff: string,
): FixOperationPreview {
  return Object.freeze({
    diff,
    effect,
    index: operation.index,
    operation: operation.operation,
    paths: operation.paths,
  });
}

function conflict(operation: ValidatedOperation, path: string, message: string): FixPlanError {
  return new FixPlanError("path-conflict", `${message}: ${path}`, operation.index, path);
}
