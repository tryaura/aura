import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RemovePathOperation } from "@tryaura/aura-sdk";

import { captureBefore, spendBudget, type RetentionBudget } from "./capture.js";
import { comparablePath } from "./claims.js";
import { renderRemoveDiff } from "./diff.js";
import type { ValidatedOperation } from "./path-policy.js";
import {
  conflict,
  createPreview,
  noop,
  type PreparedOperation,
  type PreparedRemoveOperation,
} from "./prepared.js";
import { operationError } from "./types.js";

/** Prepares an ordinary remove or one directory in a validated bottom-up removal group. */
export async function prepareRemove(
  operation: RemovePathOperation,
  validated: ValidatedOperation,
  budget: RetentionBudget,
  removeClaims: ReadonlyMap<string, number>,
  caseInsensitive: boolean,
): Promise<PreparedOperation> {
  const captured = await captureBefore(validated, operation.path, budget, "removed");
  if ("conflict" in captured) {
    return conflict(validated, captured.conflict);
  }

  const before = captured.state;
  if (before.kind === "missing") {
    return noop(validated);
  }
  const removalGroupDirectory =
    before.kind === "directory" && !before.empty
      ? await isCoveredRemovalDirectory(
          operation.path,
          validated.index,
          removeClaims,
          caseInsensitive,
        )
      : false;
  if (before.kind === "directory" && !before.empty && !removalGroupDirectory) {
    return conflict(
      validated,
      "remove accepts a non-empty directory only after all of its children are removed",
    );
  }

  spendBudget(budget, before);
  const prepared: PreparedRemoveOperation = {
    before,
    operation,
    preview: createPreview(validated, "remove", renderRemoveDiff(operation.path, before)),
    type: "remove",
  };
  return removalGroupDirectory ? { ...prepared, removalGroupDirectory: true } : prepared;
}

async function isCoveredRemovalDirectory(
  path: string,
  operationIndex: number,
  removeClaims: ReadonlyMap<string, number>,
  caseInsensitive: boolean,
): Promise<boolean> {
  let children: string[];
  try {
    children = await readdir(path);
  } catch (error) {
    throw operationError("filesystem-error", operationIndex, `could not read directory ${path}`, {
      cause: error,
      path,
    });
  }

  return children.every((child) => {
    const owner = removeClaims.get(comparablePath(resolve(join(path, child)), caseInsensitive));
    return owner !== undefined && owner < operationIndex;
  });
}
