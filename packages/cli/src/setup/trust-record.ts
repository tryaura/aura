import type { AuraManifestState, Environment, WorkspaceModel } from "@tryaura/aura-sdk";
import {
  applyFixPlan,
  AURA_TEAM_PRESET_PATH,
  AuraManifestError,
  createAuraManifestWriteOperation,
  createEmptyAuraManifest,
  createFileReader,
  FixPlanError,
  prepareFixPlan,
  readAuraManifest,
  type WorkspaceScan,
} from "@tryaura/core";

import { safe } from "../safe-text.js";
import type { RuntimeConfigResult } from "../runtime-config.js";
import { acceptedRepoPreset, setupRepoPresetContext, withTrustedRepoPreset } from "./repo-trust.js";
import type { SetupRequest } from "./setup.js";
import type { SetupRepoPresetContext } from "./types.js";

/** What boot learned once the acceptance had its chance to reach disk. */
interface BootedRepoPresetTrust {
  readonly repoPreset: SetupRepoPresetContext | undefined;
  /** The scan, carrying a re-read manifest when one was written. */
  readonly scan: WorkspaceScan;
}

/**
 * Persists an accepted repository preset before the wizard opens.
 *
 * Consent is not a configuration choice. A user who reviews the file, trusts it, and then backs
 * out of a wizard step has still answered the security question, and asking it again on the next
 * run is how a person learns to accept without reading. So the acceptance is written the moment it
 * is established, as its own one-operation plan, rather than riding along with the plan the wizard
 * confirms — which a run that never reaches the confirmation would discard.
 */
export async function bootRepoPresetTrust(
  request: SetupRequest,
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
  acceptedHash: string | undefined,
  scan: WorkspaceScan,
): Promise<BootedRepoPresetTrust> {
  const repo = configured.repoPreset;
  if (repo === undefined || !acceptedRepoPreset(configured, acceptedHash)) {
    return { repoPreset: setupRepoPresetContext(configured, acceptedHash, false), scan };
  }
  if (request.dryRun) {
    request.io.note(
      `Dry run: the acceptance of ${AURA_TEAM_PRESET_PATH} was not recorded, so the next run asks again.`,
    );
    return { repoPreset: setupRepoPresetContext(configured, acceptedHash, false), scan };
  }

  const recorded = await recordRepoPresetTrust({
    environment: request.environment,
    hash: repo.hash,
    mainWorktreePath: repo.mainWorktreePath,
    model: scan.model,
    path: repo.path,
    stateHomeDir: request.stateHomeDir,
  });
  if (recorded.manifest === undefined) {
    // Not fatal. The layer already applies to this run in memory, and the planner still folds the
    // record into the desired manifest, so the run degrades to persisting it at the end.
    request.stderr.write(
      `${request.branding.displayName}: could not record your trust of ${AURA_TEAM_PRESET_PATH} yet (${safe(recorded.problem)}). It applies to this run and is recorded when you apply the plan.\n`,
    );
    return { repoPreset: setupRepoPresetContext(configured, acceptedHash, false), scan };
  }
  return {
    repoPreset: setupRepoPresetContext(configured, acceptedHash, true),
    scan: { ...scan, model: { ...scan.model, manifest: recorded.manifest } },
  };
}

/** Either the manifest state as re-read from disk, or why nothing was written. */
export type TrustRecordOutcome =
  | { readonly manifest: AuraManifestState; readonly problem?: undefined }
  | { readonly manifest?: undefined; readonly problem: string };

/** Writes one accepted repository preset to the manifest through the fix-plan kernel. */
export async function recordRepoPresetTrust(options: {
  readonly environment: Environment;
  readonly hash: string;
  readonly mainWorktreePath: string | undefined;
  readonly model: WorkspaceModel;
  readonly path: string;
  readonly stateHomeDir: string;
}): Promise<TrustRecordOutcome> {
  const state = options.model.manifest;
  try {
    const desired = withTrustedRepoPreset(
      state.status === "ready" ? state.value : createEmptyAuraManifest(),
      {
        hash: options.hash,
        ...(options.mainWorktreePath === undefined
          ? {}
          : { mainWorktreePath: options.mainWorktreePath }),
        path: options.path,
      },
    );
    const prepared = await prepareFixPlan({
      model: options.model,
      plan: {
        operations: [createAuraManifestWriteOperation(state, desired)],
        summary: "Record the repository preset you trusted.",
      },
    });
    await applyFixPlan(prepared, {
      now: options.environment.now,
      stateHomeDir: options.stateHomeDir,
    });
    // Re-read rather than assume `desired`: the planner compares its desired state by deep equality
    // against the parsed manifest, and only a codec round trip produces the value it will see.
    return { manifest: readAuraManifest(state.path, await createFileReader().read(state.path)) };
  } catch (error) {
    if (error instanceof FixPlanError || error instanceof AuraManifestError) {
      return { problem: error.message };
    }
    throw error;
  }
}
