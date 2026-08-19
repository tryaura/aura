import type {
  AuraConfigurationLayer,
  AuraEffectiveConfig,
  AuraManifestState,
  AuraTeamPreset,
  Environment,
} from "@tryaura/aura-sdk";
import {
  AURA_TEAM_PRESET_PATH,
  isRepoPresetTrusted,
  loadTeamPreset,
  readRepoPreset,
  resolveEffectiveConfig,
  type PluginRegistry,
} from "@tryaura/core";

export interface RuntimeConfigInput {
  /**
   * Hash of repository preset contents the user accepted earlier in this run.
   *
   * A hash rather than a boolean so the layer applies only when the file still holds exactly what
   * the user saw — a write racing the prompt falls back to untrusted instead of winning consent.
   */
  readonly acceptedRepoPresetHash?: string | undefined;
  readonly cliLayer?: AuraConfigurationLayer | undefined;
  readonly cliReference?: string | undefined;
  readonly defaultPreset?: string | undefined;
  readonly defaults?: AuraConfigurationLayer | undefined;
  readonly environment: Environment;
  readonly manifest: AuraManifestState;
  readonly noCache?: boolean | undefined;
  /**
   * Whether this run may reach the network to resolve a remote preset reference.
   *
   * Off by default, matching every other command surface: a run the user did not put online stays
   * offline. A cached copy still resolves; only the fetch that would replace it is withheld.
   */
  readonly online?: boolean | undefined;
  readonly registry: PluginRegistry;
}

/** How this run treated the repository's `.aura/preset.json`, absent when no file exists. */
interface RuntimeRepoPreset {
  readonly hash: string;
  /** Same path in the primary Git checkout, present only inside a linked worktree. */
  readonly mainWorktreePath?: string | undefined;
  readonly path: string;
  readonly status: "applied" | "held";
}

export type RuntimeConfigResult =
  | { readonly message: string; readonly status: "invalid" }
  | {
      readonly config: AuraEffectiveConfig;
      /** Non-fatal problems worth showing next to the settings they affected. */
      readonly notes: readonly string[];
      readonly preset?: AuraTeamPreset | undefined;
      /** Where the active policy came from, in the words a user should see. */
      readonly presetOrigin: string;
      readonly repoPreset?: RuntimeRepoPreset | undefined;
      readonly status: "ready";
    };

/** Loads the selected preset and resolves all runtime layers once for a command. */
// fallow-ignore-next-line complexity -- composes four optional layers and the derived setup policy in one boot transaction.
export async function resolveRuntimeConfig(
  input: RuntimeConfigInput,
): Promise<RuntimeConfigResult> {
  if (input.manifest.status === "read-only") {
    return { message: input.manifest.problem.message, status: "invalid" };
  }
  const manifest = input.manifest.status === "ready" ? input.manifest.value : undefined;
  const loaded = await loadTeamPreset({
    cliReference: input.cliReference,
    defaultReference: input.defaultPreset,
    environment: input.environment,
    manifestReference: manifest?.preset,
    noCache: input.noCache,
    offline: input.online !== true,
    presets: input.registry.presets,
  });
  if (loaded.status === "invalid") {
    return loaded;
  }
  const repo = await readRepoPreset(input.environment);
  if (repo.status === "invalid") {
    // A broken repository preset fails closed: proceeding without it would silently widen
    // whatever the file was written to lock down.
    return {
      message: `${repo.diagnostics[0]?.message ?? `Repository preset ${repo.path} cannot be read.`} Fix or remove the file to continue.`,
      status: "invalid",
    };
  }
  const repoTrusted =
    repo.status === "ready" &&
    repo.hash !== undefined &&
    (repo.hash === input.acceptedRepoPresetHash || isRepoPresetTrusted(manifest, repo, repo.hash));
  const resolved = resolveEffectiveConfig({
    checks: input.registry.checks,
    cli: input.cliLayer,
    distro: input.defaults,
    knownMcpServers: new Set(input.registry.mcpServers.map((server) => server.id)),
    ...(manifest === undefined
      ? {}
      : {
          manifest: {
            ...(manifest.checks === undefined ? {} : { checks: manifest.checks }),
            skills: manifest.skills.map(({ id, source }) => ({ id, source })),
            snippets: manifest.snippets.map(({ id }) => id),
          },
        }),
    ...(loaded.status === "ready"
      ? { preset: loaded.preset, selectedPreset: loaded.selected }
      : {}),
    ...(repoTrusted ? { repo: repo.preset } : {}),
  });
  if (resolved.status === "invalid") {
    return { message: resolved.problems.join("\n"), status: "invalid" };
  }
  const hasPolicy =
    loaded.status === "ready" ||
    resolved.config.allowedSkillSources !== undefined ||
    resolved.config.skillDirectories.length > 0;
  const policyPreset: AuraTeamPreset | undefined = hasPolicy
    ? Object.freeze({
        ...(loaded.status === "ready" ? loaded.preset : {}),
        ...(resolved.config.allowedSkillSources === undefined
          ? {}
          : { allowedSkillSources: resolved.config.allowedSkillSources.value }),
        name:
          resolved.config.preset?.name ??
          resolved.config.allowedSkillSources?.provenance.label ??
          resolved.config.skillDirectories[0]?.provenance.label ??
          "runtime policy",
        schemaVersion: 1,
        skillDirectories: resolved.config.skillDirectories.map(({ value }) => value),
      })
    : undefined;
  return {
    config: resolved.config,
    notes: loaded.status === "ready" ? loaded.notes : [],
    ...(policyPreset === undefined ? {} : { preset: policyPreset }),
    presetOrigin:
      loaded.status === "ready" ? loaded.origin : (policyPreset?.name ?? AURA_TEAM_PRESET_PATH),
    ...(repo.status === "ready" && repo.hash !== undefined
      ? {
          repoPreset: {
            hash: repo.hash,
            ...(repo.mainWorktreePath === undefined
              ? {}
              : { mainWorktreePath: repo.mainWorktreePath }),
            path: repo.path,
            status: repoTrusted ? "applied" : "held",
          },
        }
      : {}),
    status: "ready",
  };
}
