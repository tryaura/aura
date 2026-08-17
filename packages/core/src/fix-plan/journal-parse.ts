import {
  JOURNAL_VERSION,
  type JournalManifest,
  type StoredArchiveOperation,
  type StoredDirectoryState,
  type StoredFileState,
  type StoredMissingState,
  type StoredMoveOperation,
  type StoredOperation,
  type StoredPathState,
  type StoredRemoveOperation,
  type StoredSymlinkOperation,
  type StoredSymlinkState,
  type StoredWriteOperation,
} from "./journal-schema.js";
import {
  corrupt,
  optionalString,
  parseStatus,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "./journal-parse-fields.js";
import { isRecord } from "../values.js";

export function parseManifest(text: string, path: string): JournalManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw corrupt(path, "manifest is not valid JSON", error);
  }

  if (!isRecord(value)) {
    throw corrupt(path, "manifest must be an object");
  }
  const operationsValue = value["operations"];
  if (!Array.isArray(operationsValue)) {
    throw corrupt(path, "manifest operations must be an array");
  }

  const operations = operationsValue.map((operation) => parseOperation(operation, path));
  const rootsValue = value["roots"];
  if (!Array.isArray(rootsValue)) {
    throw corrupt(path, "manifest roots must be an array");
  }
  const roots = rootsValue.map((root) => parseRoot(root, path));
  const version = value["version"];
  if (version !== JOURNAL_VERSION) {
    throw corrupt(path, `unsupported journal version: ${String(version)}`);
  }

  return {
    caseInsensitive: requiredBoolean(value, "caseInsensitive", path),
    createdAt: requiredString(value, "createdAt", path),
    homeDir: requiredString(value, "homeDir", path),
    id: requiredString(value, "id", path),
    operations: Object.freeze(operations),
    roots: Object.freeze(roots),
    status: parseStatus(value["status"], path),
    undoneAt: optionalString(value, "undoneAt", path),
    version,
  };
}

function parseRoot(
  value: unknown,
  path: string,
): { readonly exact: boolean; readonly path: string } {
  if (!isRecord(value)) {
    throw corrupt(path, "journal root must be an object");
  }
  return {
    exact: requiredBoolean(value, "exact", path),
    path: requiredString(value, "path", path),
  };
}

function parseOperation(value: unknown, path: string): StoredOperation {
  if (!isRecord(value)) {
    throw corrupt(path, "journal operation must be an object");
  }
  const common: OperationCommon = {
    createdDirectory: optionalString(value, "createdDirectory", path),
    index: requiredNumber(value, "index", path),
  };

  switch (value["type"]) {
    case "archive": {
      return parseArchive(value, common, path);
    }
    case "move": {
      return parseMove(value, common, path);
    }
    case "remove": {
      return parseRemove(value, common, path);
    }
    case "symlink": {
      return parseSymlink(value, common, path);
    }
    case "write": {
      return parseWrite(value, common, path);
    }
    default: {
      throw corrupt(path, `unsupported journal operation: ${String(value["type"])}`);
    }
  }
}

function parseArchive(
  value: Record<string, unknown>,
  common: OperationCommon,
  path: string,
): StoredArchiveOperation {
  const before = parseState(value["before"], path);
  if (
    before.kind !== "file" ||
    before.payload === undefined ||
    !isConsolidationPayload(before.payload)
  ) {
    throw corrupt(path, "archive before state must contain a consolidation payload");
  }
  return {
    ...common,
    after: parseReplaceableState(value["after"], path),
    before,
    path: requiredString(value, "path", path),
    type: "archive",
  };
}

interface OperationCommon {
  readonly createdDirectory?: string | undefined;
  readonly index: number;
}

function parseMove(
  value: Record<string, unknown>,
  common: OperationCommon,
  path: string,
): StoredMoveOperation {
  const sourceBefore = parseState(value["sourceBefore"], path);
  if (sourceBefore.kind !== "directory" && sourceBefore.kind !== "file") {
    throw corrupt(path, "move source state must be a file or directory");
  }
  return {
    ...common,
    destinationPath: requiredString(value, "destinationPath", path),
    sourceBefore,
    sourcePath: requiredString(value, "sourcePath", path),
    type: "move",
  };
}

function parseRemove(
  value: Record<string, unknown>,
  common: OperationCommon,
  path: string,
): StoredRemoveOperation {
  const before = parseState(value["before"], path);
  if (before.kind === "missing") {
    throw corrupt(path, "remove before state cannot be missing");
  }
  return {
    ...common,
    before,
    path: requiredString(value, "path", path),
    type: "remove",
  };
}

function parseSymlink(
  value: Record<string, unknown>,
  common: OperationCommon,
  path: string,
): StoredSymlinkOperation {
  return {
    ...common,
    before: parseReplaceableState(value["before"], path),
    path: requiredString(value, "path", path),
    target: requiredString(value, "target", path),
    type: "symlink",
  };
}

function parseWrite(
  value: Record<string, unknown>,
  common: OperationCommon,
  path: string,
): StoredWriteOperation {
  const after = parseState(value["after"], path);
  if (after.kind !== "file" || after.payload === undefined) {
    throw corrupt(path, "write after state must contain a file payload");
  }
  return {
    ...common,
    after,
    before: parseReplaceableState(value["before"], path),
    path: requiredString(value, "path", path),
    type: "write",
  };
}

function parseReplaceableState(
  value: unknown,
  path: string,
): StoredFileState | StoredMissingState | StoredSymlinkState {
  const state = parseState(value, path);
  if (state.kind === "directory") {
    throw corrupt(path, "replaceable state cannot be a directory");
  }
  return state;
}

function parseState(value: unknown, path: string): StoredPathState {
  if (!isRecord(value)) {
    throw corrupt(path, "path state must be an object");
  }
  switch (value["kind"]) {
    case "missing": {
      return { kind: "missing" };
    }
    case "symlink": {
      return { kind: "symlink", target: requiredString(value, "target", path) };
    }
    case "file": {
      return parseFileState(value, path);
    }
    case "directory": {
      const state: StoredDirectoryState = {
        empty: requiredBoolean(value, "empty", path),
        kind: "directory",
        mode: requiredMode(value, path),
        modifiedTimeMs: requiredNumber(value, "modifiedTimeMs", path),
      };
      return state;
    }
    default: {
      throw corrupt(path, `unsupported path state: ${String(value["kind"])}`);
    }
  }
}

function parseFileState(value: Record<string, unknown>, path: string): StoredFileState {
  const payload = optionalString(value, "payload", path);
  if (
    payload !== undefined &&
    !/^files\/[0-9]+-(?:after|before)\.bin$/u.test(payload) &&
    !isConsolidationPayload(payload)
  ) {
    throw corrupt(path, `invalid file payload path: ${payload}`);
  }
  return {
    kind: "file",
    mode: requiredMode(value, path),
    modifiedTimeMs: requiredNumber(value, "modifiedTimeMs", path),
    payload,
    size: requiredNumber(value, "size", path),
  };
}

function isConsolidationPayload(payload: string): boolean {
  const parts = payload.split(/[\\/]/u);
  return (
    parts[0] === "consolidation" &&
    parts.length > 1 &&
    parts.slice(1).every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

/**
 * A permission mode, masked to the bits a capture can produce.
 *
 * The value goes straight to `chmod` during a restore, and everything above `0o777` — setuid,
 * setgid, sticky — is a privilege the file never had when Aura read it. Capture masks on the way in;
 * masking again on the way out means a manifest cannot grant what a capture could not.
 */
function requiredMode(value: Record<string, unknown>, path: string): number {
  const mode = requiredNumber(value, "mode", path);
  if (!Number.isInteger(mode) || mode < 0) {
    throw corrupt(path, "mode must be a non-negative integer");
  }
  return mode & 0o777;
}
