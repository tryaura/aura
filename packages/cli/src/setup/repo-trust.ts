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
  if (isRepoPresetTrusted(manifest, repo.path, repo.hash) || !options.interactive) {
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

function checksPreview(checks: AuraTeamPreset["checks"]): string | undefined {
  if (checks === undefined) {
    return undefined;
  }
  const value = JSON.stringify(checks) ?? "{}";
  return `Checks: ${safe(value)}`;
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

/** The repository-preset slice steps and the planner read, absent when no file exists. */
export function setupRepoPresetContext(
  configured: Extract<RuntimeConfigResult, { status: "ready" }>,
  acceptedHash: string | undefined,
): SetupRepoPresetContext | undefined {
  const repo = configured.repoPreset;
  if (repo === undefined) {
    return undefined;
  }
  return Object.freeze({
    // Accepted only when the applied layer still holds exactly what the prompt showed; an already
    // recorded trust resolves without a prompt and needs no new manifest entry.
    accepted: repo.status === "applied" && repo.hash === acceptedHash,
    checkSummary:
      repo.status === "applied" ? presetCheckSummary(configured.config, "repo") : Object.freeze([]),
    hash: repo.hash,
    path: repo.path,
    status: repo.status,
  });
}

/** Records one accepted repository preset, replacing any earlier acceptance for the same path. */
export function withTrustedRepoPreset(
  manifest: AuraManifest,
  record: AuraManifestTrustedRepoPreset,
): AuraManifest {
  const previous = (manifest.trustedRepoPresets ?? []).filter(
    (entry) => entry.path !== record.path,
  );
  // Newest last; dropping from the front keeps the list within what the schema accepts.
  const entries = [...previous, record].slice(-MAX_TRUSTED_REPO_PRESETS);
  return { ...manifest, trustedRepoPresets: entries };
}
