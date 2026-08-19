import type { Buffer } from "node:buffer";

import type { FileMode, WriteFileOperation } from "@tryaura/aura-sdk";

import { AURA_MANIFEST_FILE_MODE, resolveAuraManifestPath } from "../manifest/protocol.js";
import { comparablePath } from "./claims.js";
import { DEFAULT_FILE_MODE } from "./limits.js";
import type { PreparedWriteOperation } from "./prepared.js";
import { isCapturedFile } from "./state.js";

/** Resolves the mode core enforces on a path, or undefined when the path is not core's to hold. */
export type EnforcedModes = (path: string) => FileMode | undefined;

/**
 * The files core holds at a fixed mode regardless of what a plan asked for.
 *
 * Keyed by path rather than by anything a plan carries, so this cannot be opted into: a plugin that
 * wants an existing file chmodded has no way to express it. Only the manifest qualifies today.
 */
export function createEnforcedModes(homeDir: string, caseInsensitive: boolean): EnforcedModes {
  const manifest = comparablePath(resolveAuraManifestPath(homeDir), caseInsensitive);
  return (path) =>
    comparablePath(path, caseInsensitive) === manifest ? AURA_MANIFEST_FILE_MODE : undefined;
}

/**
 * Settles what the file's permissions will be, once, while the preview is rendered.
 *
 * Three rules in priority order: core holds its own protocol files at a fixed mode, an existing
 * file keeps what the user gave it, and only a file being created takes the mode a plan asked for.
 * Deciding it here is what keeps the preview, the journal, and the write from each deriving it
 * separately and drifting apart.
 */
export function resolveWriteMode(
  operation: WriteFileOperation,
  before: PreparedWriteOperation["before"],
  enforcedMode: EnforcedModes,
): number {
  const enforced = enforcedMode(operation.path);
  if (enforced !== undefined) {
    return enforced;
  }

  return before.kind === "file" ? before.mode : (operation.mode ?? DEFAULT_FILE_MODE);
}

/** Whether a prepared write must replace bytes rather than only correct an enforced mode. */
export function writeContentsChanged(
  before: PreparedWriteOperation["before"],
  content: Buffer,
): boolean {
  return !isCapturedFile(before) || !before.content.equals(content);
}
