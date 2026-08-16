import { Buffer } from "node:buffer";

import type { ArchiveFileOperation, FileMode } from "@tryaura/aura-sdk";

import { captureBefore, spendBudget, type RetentionBudget } from "./capture.js";
import { renderArchiveDiff } from "./diff.js";
import { FILE_MODES, MAX_MUTABLE_FILE_BYTES } from "./limits.js";
import type { ValidatedOperation } from "./path-policy.js";
import { conflict, createPreview, type PreparedOperation } from "./prepared.js";

export async function prepareArchive(
  operation: ArchiveFileOperation,
  validated: ValidatedOperation,
  budget: RetentionBudget,
  enforcedMode: (path: string) => FileMode | undefined,
): Promise<PreparedOperation> {
  const invalidPath = archivePathProblem(operation.relativePath);
  if (invalidPath !== undefined) {
    return conflict(validated, invalidPath);
  }

  const replacement = operation.replacement;
  if (replacement?.type === "write") {
    const content = Buffer.from(replacement.content, "utf8");
    if (content.byteLength > MAX_MUTABLE_FILE_BYTES) {
      return conflict(
        validated,
        `content is ${content.byteLength} bytes, above the ${MAX_MUTABLE_FILE_BYTES} byte limit for one operation`,
      );
    }
    if (replacement.mode !== undefined && !FILE_MODES.has(replacement.mode)) {
      return conflict(
        validated,
        `mode 0o${replacement.mode.toString(8)} is not a permitted file mode`,
      );
    }
  }

  const captured = await captureBefore(validated, operation.path, budget, "archived");
  if ("conflict" in captured) {
    return conflict(validated, captured.conflict);
  }
  if (captured.state.kind !== "file") {
    return conflict(validated, "archive source must be a regular file");
  }

  const before = captured.state;
  const replacementMode =
    replacement?.type === "write" ? (enforcedMode(operation.path) ?? before.mode) : undefined;
  spendBudget(budget, before);
  return {
    before,
    operation,
    preview: createPreview(
      validated,
      "archive",
      renderArchiveDiff(
        operation.path,
        operation.relativePath,
        before,
        replacement,
        replacementMode,
      ),
    ),
    replacementMode,
    type: "archive",
  };
}

function archivePathProblem(path: string): string | undefined {
  const invalid =
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.split(/[\\/]/u).some((part) => part.length === 0 || part === "." || part === "..");
  return invalid
    ? "archive relativePath must be a non-empty relative path without traversal"
    : undefined;
}
