import type { AuraManifest, AuraManifestState, WriteFileOperation } from "@tryaura/aura-sdk";

import { serializeAuraManifest } from "./codec.js";
import { AuraManifestError } from "./error.js";
import { AURA_MANIFEST_FILE_MODE } from "./protocol.js";

/** Refuses any write based on desired state Aura could not safely understand. */
export function assertAuraManifestWritable(state: AuraManifestState): void {
  if (state.status === "read-only") {
    throw new AuraManifestError(state.path, state.problem);
  }
}

/**
 * Builds the fix-plan operation used to persist a complete manifest.
 *
 * `mode` covers creating the file. Holding an existing one at the same mode is not this function's
 * to ask for: the kernel recognizes the manifest by path and enforces it there.
 */
export function createAuraManifestWriteOperation(
  state: AuraManifestState,
  manifest: AuraManifest,
): WriteFileOperation {
  assertAuraManifestWritable(state);
  return Object.freeze({
    content: serializeAuraManifest(manifest, state.path),
    mode: AURA_MANIFEST_FILE_MODE,
    path: state.path,
    type: "write",
  });
}
