import type {
  Adapter,
  AuraPlugin,
  Check,
  McpServerDef,
  Preset,
  SkillPack,
  SkillSource,
  Snippet,
} from "@tryaura/aura-sdk";

import {
  claimId,
  collectAdapterViolations,
  collectChecks,
  collectIdentityViolations,
  collectNamespaced,
  collectUnknownBareCheckIdPlugins,
  collectUnnamespaced,
  type ContributionKind,
  createRegistryState,
  formatApiVersionViolation,
  formatViolations,
  isSupportedPlugin,
  type PluginCandidate,
  type RegistryState,
} from "./plugin-validation.js";

/** Options controlling distribution-owned plugin registry policy. */
export interface PluginRegistryOptions {
  /**
   * Plugins allowed to contribute bare, un-namespaced check ids such as `INS-001`.
   *
   * The grant is matched against the self-declared {@link AuraPlugin.id}, which is only meaningful
   * because `candidates` is a build-time list the distribution controls. An id named here that no
   * candidate declares is rejected, so a stale or misspelled grant fails at startup rather than
   * silently withdrawing the privilege.
   */
  readonly bareCheckIdPlugins?: readonly string[] | undefined;
}

/** Validated plugin contributions available to Aura core. */
export interface PluginRegistry {
  readonly adapters: readonly Adapter[];
  readonly checks: readonly Check[];
  readonly mcpServers: readonly McpServerDef[];
  /**
   * Resolves the plugin that contributed `id`, or `undefined` when nothing claims it.
   *
   * Findings and diagnostics are reported with the contributing plugin's name and version, and a
   * bare check id carries no namespace to recover that from, so ownership is looked up rather than
   * parsed back out of the id.
   */
  readonly ownerOf: (kind: ContributionKind, id: string) => AuraPlugin | undefined;
  readonly plugins: readonly AuraPlugin[];
  readonly presets: readonly Preset[];
  readonly skills: readonly SkillPack[];
  readonly skillSources: readonly SkillSource[];
  readonly snippets: readonly Snippet[];
}

/** Everything accepted so far, one list per contribution kind. */
interface CollectedContributions {
  readonly adapters: Adapter[];
  readonly checks: Check[];
  readonly mcpServers: McpServerDef[];
  readonly plugins: AuraPlugin[];
  readonly presets: Preset[];
  readonly skills: SkillPack[];
  readonly skillSources: SkillSource[];
  readonly snippets: Snippet[];
}

/**
 * Validates and flattens the build-time plugin list for a distribution.
 *
 * Every problem across every plugin is collected and reported in one error, so a distribution with
 * several mistakes is fixed in one pass rather than one rebuild per mistake.
 */
export function createPluginRegistry(
  candidates: readonly PluginCandidate[],
  options: PluginRegistryOptions = {},
): PluginRegistry {
  const state = createRegistryState();
  const bareCheckIdPlugins = new Set(options.bareCheckIdPlugins ?? []);
  const collected: CollectedContributions = {
    adapters: [],
    checks: [],
    mcpServers: [],
    plugins: [],
    presets: [],
    skills: [],
    skillSources: [],
    snippets: [],
  };

  collectUnknownBareCheckIdPlugins(state, bareCheckIdPlugins, candidates);

  for (const candidate of candidates) {
    collectCandidate(state, candidate, bareCheckIdPlugins, collected);
  }

  if (state.violations.length > 0) {
    throw new Error(formatViolations(state.violations));
  }

  // `readonly` is erased at runtime, and plugin code runs in this process, so the validated result
  // is frozen rather than left mutable behind a compile-time-only guarantee.
  return Object.freeze({
    adapters: Object.freeze(collected.adapters),
    checks: Object.freeze(collected.checks),
    mcpServers: Object.freeze(collected.mcpServers),
    ownerOf: (kind: ContributionKind, id: string) => state.owners.get(kind)?.get(id),
    plugins: Object.freeze(collected.plugins),
    presets: Object.freeze(collected.presets),
    skills: Object.freeze(collected.skills),
    skillSources: Object.freeze(collected.skillSources),
    snippets: Object.freeze(collected.snippets),
  });
}

/** Accepts one candidate's contributions, or records why none of them can be trusted. */
function collectCandidate(
  state: RegistryState,
  candidate: PluginCandidate,
  bareCheckIdPlugins: ReadonlySet<string>,
  collected: CollectedContributions,
): void {
  if (!isSupportedPlugin(candidate)) {
    state.violations.push(formatApiVersionViolation(candidate));
    return;
  }

  const plugin = candidate;
  // A plugin whose own identity is unusable would cascade a namespace error into every
  // contribution it declares, so only the root cause is reported.
  if (!collectIdentityViolations(state, plugin) || !claimId(state, "plugin", plugin.id, plugin)) {
    return;
  }

  collected.plugins.push(plugin);

  collectAdapterViolations(state, plugin.adapters, plugin);

  // Adapter ids name the application itself (`claude-code`, `cursor`) rather than the plugin, so
  // they are deliberately global: two plugins teaching Aura the same app must collide, not coexist
  // under separate namespaces.
  collectUnnamespaced(state, "adapter", plugin.adapters, plugin, collected.adapters);
  const allowsBareCheckIds = bareCheckIdPlugins.has(plugin.id);
  collectChecks(state, plugin.checks, plugin, allowsBareCheckIds, collected.checks);
  collectNamespaced(state, "mcp-server", plugin.mcpCatalog, plugin, collected.mcpServers);
  collectNamespaced(state, "preset", plugin.presets, plugin, collected.presets);
  collectNamespaced(state, "skill-pack", plugin.skills, plugin, collected.skills);
  collectNamespaced(state, "skill-source", plugin.skillSources, plugin, collected.skillSources);
  collectNamespaced(state, "snippet", plugin.snippets, plugin, collected.snippets);
}
