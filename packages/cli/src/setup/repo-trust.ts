import type {
  AuraManifest,
  AuraManifestState,
  AuraManifestTrustedRepoPreset,
  AuraTeamPreset,
  Environment,
} from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  isRepoPresetTrusted,
  MAX_TRUSTED_REPO_PRESETS,
  readRepoPreset,
} from "@tryaura/core";

import { safe } from "../safe-text.js";
import { presetCheckSummary } from "./preset-policy.js";
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
}): Promise<RepoPresetTrustOutcome> {
  const repo = await readRepoPreset(options.environment);
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
      ? `This repository provides a preset at ${AURA_TEAM_PRESET_PATH}.`
      : `This repository provides the preset "${safe(name)}" at ${AURA_TEAM_PRESET_PATH}.`,
  );
  if (repo.preset !== undefined) {
    options.io.note(repoPresetTrustPreview(repo.preset));
  }
  if (repo.mainWorktreePath !== undefined) {
    options.io.note(
      "This directory is a linked worktree, so trusting these contents also applies them in every other worktree of the same checkout.",
    );
  }
  // Keyed on this file alone: "changed since you trusted it" is only true of the file the user is
  // looking at, and a sibling worktree carrying different contents is a first sighting.
  const changed = (manifest?.trustedRepoPresets ?? []).some((entry) => entry.path === repo.path);
  const confirmation = await options.io.confirm(
    changed
      ? `The repository preset at ${AURA_TEAM_PRESET_PATH} changed since you trusted it. Trust the new contents?`
      : `Trust the repository preset at ${AURA_TEAM_PRESET_PATH}? Its settings apply to every Aura run in this repository until the file changes.`,
  );
  if (confirmation === "aborted") {
    return { kind: "aborted" };
  }
  return confirmation === "accepted"
    ? { acceptedHash: repo.hash, kind: "resolved" }
    : { kind: "resolved" };
}

/** Security-relevant capabilities shown before repository-controlled settings are accepted. */
function repoPresetTrustPreview(preset: AuraTeamPreset): string {
  const settings = [
    checksPreview(preset.checks),
    listPreview("Required MCP servers", preset.requiredMcpServers),
    listPreview("Allowed skill sources", preset.allowedSkillSources),
    ...(preset.skillDirectories ?? []).map(directoryPreview),
    listPreview(
      "Selected skills",
      preset.skills?.map((skill) => `${skill.source}/${skill.id}`),
    ),
    listPreview("Selected snippets", preset.snippets),
  ].filter((line) => line !== undefined);
  return [
    "Review these repository-controlled settings before trusting:",
    ...(settings.length === 0 ? ["No check, MCP, skill, or snippet settings."] : settings),
  ].join("\n");
}

/** The exact check settings the repository preset asks the user to trust. */
function checksPreview(checks: AuraTeamPreset["checks"]): string | undefined {
  if (checks === undefined) {
    return undefined;
  }
  const settings = [
    ...(checks.disabled ?? []).map((id) => `${safe(id)}: disabled`),
    ...(checks.enabled ?? []).map((id) => `${safe(id)}: enabled`),
    ...Object.entries(checks.severity ?? {}).map(
      ([id, severity]) => `${safe(id)}: severity ${safe(severity)}`,
    ),
    ...Object.entries(checks.thresholds ?? {}).map(
      ([id, thresholds]) => `${safe(id)}: thresholds ${safe(JSON.stringify(thresholds))}`,
    ),
  ].sort();
  return `Checks: ${settings.length === 0 ? "(none)" : settings.join("; ")}`;
}

function directoryPreview(source: NonNullable<AuraTeamPreset["skillDirectories"]>[number]): string {
  const token = source.kind === "private-directory" ? `; token ${safe(source.tokenEnv)}` : "";
  return `Skill directory: ${safe(source.name)} — ${safe(source.url)}${token}`;
}

function listPreview(label: string, values: readonly string[] | undefined): string | undefined {
  return values === undefined ? undefined : `${label}: ${listValues(values)}`;
}

function listValues(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.map(safe).join(", ");
}

/**
 * Whether this run's prompt accepted exactly the contents the resolved layer applied.
 *
 * The two reads of the file — the prompt's and configuration resolution's — are independent, so a
 * write that lands between them leaves the layer held. Recording trust for a layer that did not
 * apply would claim consent for settings this run never used.
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
    hash: repo.hash,
    ...(repo.mainWorktreePath === undefined ? {} : { mainWorktreePath: repo.mainWorktreePath }),
    path: repo.path,
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
