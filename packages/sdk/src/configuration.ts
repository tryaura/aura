import type { JsonObject, Severity } from "./common.js";
import type { DirectorySkillSource, SkillSourceId } from "./content.js";

/** A source-qualified skill selection carried by a distribution or team preset. */
export interface AuraPresetSkillSelection {
  readonly id: string;
  readonly source: SkillSourceId;
}

/** Data-only check configuration shared by every configuration layer. */
export interface AuraCheckConfiguration {
  readonly disabled?: readonly string[] | undefined;
  readonly enabled?: readonly string[] | undefined;
  readonly severity?: Readonly<Record<string, Severity>> | undefined;
  readonly thresholds?: Readonly<Record<string, JsonObject>> | undefined;
}

/** One declarative configuration layer before precedence is resolved. */
export interface AuraConfigurationLayer {
  readonly allowedSkillSources?: readonly SkillSourceId[] | undefined;
  readonly checks?: AuraCheckConfiguration | undefined;
  readonly requiredMcpServers?: readonly string[] | undefined;
  readonly skillDirectories?: readonly DirectorySkillSource[] | undefined;
  readonly skills?: readonly AuraPresetSkillSelection[] | undefined;
  readonly snippets?: readonly string[] | undefined;
}

/**
 * The layer that supplied one effective configuration value.
 *
 * `default` is the built-in value a check declares for itself. It is distinct from `distro`
 * because a distribution that restates a default has made a choice, and a value nobody chose must
 * stay distinguishable from one somebody did: a check that sets a severity per occurrence outranks
 * its own default but not a configured override.
 *
 * `repo` is the repository's `.aura/preset.json`, applied above the selected team preset and below
 * the user manifest — and only after the user trusted that file for the repository, because it
 * arrives by cloning rather than by anything the user selected.
 */
export type AuraConfigurationLayerName =
  | "cli"
  | "default"
  | "distro"
  | "manifest"
  | "preset"
  | "repo";

/** Human- and machine-readable provenance for an effective value. */
export interface AuraConfigurationProvenance {
  readonly label: string;
  readonly layer: AuraConfigurationLayerName;
}

/** One resolved value paired with the layer that won. */
export interface AuraEffectiveValue<T> {
  readonly provenance: AuraConfigurationProvenance;
  readonly value: T;
}

/** Effective settings for one registered check. */
export interface AuraEffectiveCheckConfiguration {
  readonly enabled: AuraEffectiveValue<boolean>;
  readonly severity: AuraEffectiveValue<Severity>;
  readonly thresholds: AuraEffectiveValue<JsonObject>;
}

/** The selected preset after reference precedence and loading. */
export interface AuraEffectivePreset {
  readonly name: string;
  readonly reference: string;
}

/** Immutable configuration resolved once at process boot. */
export interface AuraEffectiveConfig {
  readonly allowedSkillSources?: AuraEffectiveValue<readonly SkillSourceId[]> | undefined;
  readonly checks: Readonly<Record<string, AuraEffectiveCheckConfiguration>>;
  readonly preset?: AuraEffectivePreset | undefined;
  readonly requiredMcpServers: readonly AuraEffectiveValue<string>[];
  readonly skillDirectories: readonly AuraEffectiveValue<DirectorySkillSource>[];
  readonly skills: readonly AuraEffectiveValue<AuraPresetSkillSelection>[];
  readonly snippets: readonly AuraEffectiveValue<string>[];
}
