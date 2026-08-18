import { isDeepStrictEqual } from "node:util";

import type { AuraManifest, FileOperation } from "@tryaura/aura-sdk";
import {
  AURA_MANIFEST_FILE_MODE,
  AuraManifestError,
  createAuraManifestWriteOperation,
} from "@tryaura/core";

import type { SetupBlocker } from "./planner.js";
import type { SetupSelections, SetupStepContext } from "./types.js";

/** The manifest write this run needs, or the reason the desired state cannot be persisted. */
export interface ManifestWritePlan {
  readonly blockers: readonly SetupBlocker[];
  readonly operations: readonly FileOperation[];
}

/**
 * Builds the manifest write, reporting a desired state the manifest schema refuses as a blocker.
 *
 * Serialization validates, so a selection the wizard let through but the schema rejects — two
 * servers claiming one name for one application, say — would otherwise surface as a thrown run
 * after every question was answered, taking the user's whole session with it. The steps validate
 * the same rules up front; this is the backstop that keeps a gap between them a blocked plan
 * rather than a lost one.
 */
export function planManifestWrite(
  context: SetupStepContext,
  desired: AuraManifest,
  createManifest: boolean,
  apps: SetupSelections["apps"],
): ManifestWritePlan {
  if (
    context.manifest.status === "read-only" ||
    !shouldWriteManifest(context, desired, createManifest, apps)
  ) {
    return { blockers: [], operations: [] };
  }
  try {
    return {
      blockers: [],
      operations: [createAuraManifestWriteOperation(context.manifest, desired)],
    };
  } catch (error) {
    if (error instanceof AuraManifestError) {
      return { blockers: [{ path: error.path, reason: error.problem.message }], operations: [] };
    }
    throw error;
  }
}

/** Decides whether desired manifest bytes or their required private mode differ from disk. */
function shouldWriteManifest(
  context: SetupStepContext,
  desired: AuraManifest,
  createManifest: boolean,
  apps: SetupSelections["apps"],
): boolean {
  return context.manifest.status === "ready"
    ? differsFromDisk(context.manifest, desired)
    : createManifest || answersSomethingToRecord(context.selections, apps);
}

function differsFromDisk(
  state: Extract<SetupStepContext["manifest"], { readonly status: "ready" }>,
  desired: AuraManifest,
): boolean {
  const mode = state.mode;
  return (
    !isDeepStrictEqual(state.value, desired) ||
    (mode !== undefined && mode !== AURA_MANIFEST_FILE_MODE)
  );
}

/** Whether this run answered anything a manifest that does not exist yet would have to hold. */
function answersSomethingToRecord(
  selections: SetupSelections,
  apps: SetupSelections["apps"],
): boolean {
  return (
    (apps !== undefined && apps.managed.length > 0) ||
    selections.instructions !== undefined ||
    selections.mcp !== undefined ||
    selections.snippets !== undefined ||
    // The slice, not its presence: the skills step keeps an approvals-only slice alive so a
    // revisit does not re-ask which private directories may be contacted, and approving a
    // connection is not on its own a reason to write a manifest.
    (selections.skills?.selected.length ?? 0) > 0
  );
}
