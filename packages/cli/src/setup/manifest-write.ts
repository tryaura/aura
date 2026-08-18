import { isDeepStrictEqual } from "node:util";

import type { AuraManifest } from "@tryaura/aura-sdk";
import { AURA_MANIFEST_FILE_MODE } from "@tryaura/core";

import type { SetupSelections, SetupStepContext } from "./types.js";

/** Decides whether desired manifest bytes or their required private mode differ from disk. */
export function shouldWriteManifest(
  context: SetupStepContext,
  desired: AuraManifest,
  createManifest: boolean,
  apps: SetupSelections["apps"],
): boolean {
  if (context.manifest.status === "ready") {
    const mode = context.manifest.mode;
    return (
      !isDeepStrictEqual(context.manifest.value, desired) ||
      (mode !== undefined && mode !== AURA_MANIFEST_FILE_MODE)
    );
  }
  return (
    createManifest ||
    (apps !== undefined && apps.managed.length > 0) ||
    context.selections.instructions !== undefined ||
    context.selections.snippets !== undefined ||
    // The slice, not its presence: the skills step keeps an approvals-only slice alive so a
    // revisit does not re-ask which private directories may be contacted, and approving a
    // connection is not on its own a reason to write a manifest.
    (context.selections.skills?.selected.length ?? 0) > 0
  );
}
