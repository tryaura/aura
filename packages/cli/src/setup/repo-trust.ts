import type {
  AuraManifest,
  AuraManifestState,
  AuraManifestTrustedRepoPreset,
  Environment,
  RepoContentSet,
} from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  isRepoPresetTrusted,
  MAX_TRUSTED_REPO_PRESETS,
  readRepoPreset,
} from "@tryaura/core";

import { safe } from "../safe-text.js";
import { presetCheckSummary } from "./preset-policy.js";
import { hasRepoContent, repoPresetTrustPreview } from "./repo-trust-preview.js";
import type { RuntimeConfigResult } from "../runtime-config.js";
import type { SetupRepoPresetContext } from "./types.js";
import type { WizardIo } from "./wizard-types.js";

/** What boot learned about repository preset trust before resolving configuration. */
export type RepoPresetTrustOutcome =
  | { readonly kind: "aborted" }
  | {
      /** Set when the user accepted the current contents during this run's prompt. */
      readonly acceptedHash?: string | undefined;
      readonly kind: "resolved";
    };

/**
 * Asks whether an untrusted repository preset may be applied, once per repo and contents.
 *
 * Only an interactive run may ask: a scripted io answers every confirmation with its default, and
 * the first application of a file that arrived by cloning is exactly the decision it must not
 * answer. A non-interactive run resolves without the layer, and the plan summary says so.
 */
export async function establishRepoPresetTrust(options: {
  readonly environment: Environment;
  readonly interactive: boolean;
  readonly io: WizardIo;
  readonly manifest: AuraManifestState;
  /** Snapshot boot already read, reused through the trust decision. */
  readonly repoPresetState?: Awaited<ReturnType<typeof readRepoPreset>> | undefined;
}): Promise<RepoPresetTrustOutcome> {
  const repo = options.repoPresetState ?? (await readRepoPreset(options.environment));
  if (repo.status !== "ready" || repo.hash === undefined) {
    return { kind: "resolved" };
  }
  const manifest = options.manifest.status === "ready" ? options.manifest.value : undefined;
  if (isRepoPresetTrusted(manifest, repo, repo.hash) || !options.interactive) {
    return { kind: "resolved" };
  }

  const name = repo.preset?.name;
  options.io.note(
    name === undefined
      ? `Repository preset — ${AURA_TEAM_PRESET_PATH}`
      : `Repository preset "${safe(name)}" — ${AURA_TEAM_PRESET_PATH}`,
  );
  if (repo.preset !== undefined) {
    options.io.note(repoPresetTrustPreview(repo.preset, repo.contentSet));
  }
  if (repo.mainWorktreePath !== undefined) {
    options.io.note(
      "This directory is a linked worktree, so trusting these contents also applies them in every other worktree of the same checkout.",
    );
  }
  // Keyed on this file alone: "changed since you trusted it" is only true of the file the user is
  // looking at, and a sibling worktree carrying different contents is a first sighting.
  const changed = (manifest?.trustedRepoPresets ?? []).some((entry) => entry.path === repo.path);
  const confirmation = await options.io.confirm(trustPrompt(changed, repo.contentSet));
  if (confirmation === "aborted") {
    return { kind: "aborted" };
  }
  return confirmation === "accepted"
    ? { acceptedHash: repo.hash, kind: "resolved" }
    : { kind: "resolved" };
}

/**
 * The question itself, short because the note above it already named the file and its contents.
 *
 * The two-tier contract rides here rather than in the summary: a preset that only carries policy
 * installs nothing either way, so promising a later tick would be noise in the one line the user
 * is certain to read.
 */
function trustPrompt(changed: boolean, contentSet: RepoContentSet | undefined): string {
  if (changed) {
    return "The preset changed since you trusted it. Trust the new contents?";
  }
  return hasRepoContent(contentSet)
    ? "Trust it? Nothing installs until you pick it; applies to every run here until the file changes."
    : "Trust it? Applies to every run here until the file changes.";
}

/**
 * Whether this run's prompt accepted exactly the contents the resolved layer applied.
 *
 * Boot passes one immutable snapshot through the prompt and configuration resolution. Comparing
 * hashes here keeps this helper correct for direct callers too: trust is recorded only for the
 * layer this run actually applied.
 */
export function acceptedRepoPreset(
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
  acceptedHash: string | undefined,
): boolean {
  const repo = configured.repoPreset;
  return repo !== undefined && repo.status === "applied" && repo.hash === acceptedHash;
}

/** The repository-preset slice steps and the planner read, absent when no file exists. */
export function setupRepoPresetContext(
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
  acceptedHash: string | undefined,
  recorded: boolean,
): SetupRepoPresetContext | undefined {
  const repo = configured.repoPreset;
  if (repo === undefined) {
    return undefined;
  }
  return Object.freeze({
    accepted: acceptedRepoPreset(configured, acceptedHash),
    checkSummary:
      repo.status === "applied" ? presetCheckSummary(configured.config, "repo") : Object.freeze([]),
    ...(repo.contentSet === undefined ? {} : { contentSet: repo.contentSet }),
    hash: repo.hash,
    ...(repo.mainWorktreePath === undefined ? {} : { mainWorktreePath: repo.mainWorktreePath }),
    path: repo.path,
    ...(repo.preset === undefined ? {} : { preset: repo.preset }),
    recorded,
    status: repo.status,
  });
}

/** Records one accepted repository preset while retaining earlier accepted contents. */
export function withTrustedRepoPreset(
  manifest: AuraManifest,
  record: AuraManifestTrustedRepoPreset,
): AuraManifest {
  const previous = (manifest.trustedRepoPresets ?? []).filter(
    (entry) => entry.path !== record.path || entry.hash !== record.hash,
  );
  // Newest last; dropping from the front keeps the list within what the schema accepts.
  const entries = [...previous, record].slice(-MAX_TRUSTED_REPO_PRESETS);
  return { ...manifest, trustedRepoPresets: entries };
}
