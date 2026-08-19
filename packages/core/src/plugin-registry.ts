import type {
  Adapter,
  AuraPlugin,
  Check,
  DirectorySkillSource,
  McpServerDef,
  Preset,
  BundledSkillSource,
  SkillPack,
  SkillSourceDriver,
  Snippet,
} from "@tryaura/aura-sdk";

import { directorySourceProblem } from "./skills/directory-config.js";
import { contentVersionProblem } from "./plugin-validation-version.js";
import { collectFindingGroupViolations } from "./plugin-validation-finding-group.js";
import { skillIdProblem } from "./skills/path-guards.js";

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
  readonly skillDirectories: readonly DirectorySkillSource[];
  readonly skills: readonly RegisteredSkillPack[];
  readonly skillSources: readonly SkillSourceDriver[];
  readonly snippets: readonly Snippet[];
}

/** A bundled skill paired with the plugin source that owns its local id. */
export interface RegisteredSkillPack {
  readonly skill: SkillPack;
  readonly source: BundledSkillSource;
}

/** Everything accepted so far, one list per contribution kind. */
interface CollectedContributions {
  readonly adapters: Adapter[];
  readonly checks: Check[];
  readonly mcpServers: McpServerDef[];
  readonly plugins: AuraPlugin[];
  readonly presets: Preset[];
  readonly skillDirectories: DirectorySkillSource[];
  readonly skills: RegisteredSkillPack[];
  readonly skillSources: SkillSourceDriver[];
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
    skillDirectories: [],
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
    skillDirectories: Object.freeze(collected.skillDirectories),
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
  collectFindingGroupViolations(state, plugin.checks, plugin);

  // Adapter ids name the application itself (`claude-code`, `cursor`) rather than the plugin, so
  // they are deliberately global: two plugins teaching Aura the same app must collide, not coexist
  // under separate namespaces.
  collectUnnamespaced(state, "adapter", plugin.adapters, plugin, collected.adapters);
  const allowsBareCheckIds = bareCheckIdPlugins.has(plugin.id);
  collectChecks(state, plugin.checks, plugin, allowsBareCheckIds, collected.checks);
  collectNamespaced(state, "mcp-server", plugin.mcpCatalog, plugin, collected.mcpServers);
  collectNamespaced(state, "preset", plugin.presets, plugin, collected.presets);
  collectSkillDirectories(state, plugin, collected.skillDirectories);
  collectSkills(state, plugin, collected.skills);
  collectNamespaced(state, "skill-source", plugin.skillSources, plugin, collected.skillSources);
  collectSnippets(state, plugin, collected.snippets);
}

/** Snippets are managed content, so their revision has to be comparable before one is installed. */
function collectSnippets(state: RegistryState, plugin: AuraPlugin, collected: Snippet[]): void {
  const claimed: Snippet[] = [];
  collectNamespaced(state, "snippet", plugin.snippets, plugin, claimed);
  for (const snippet of claimed) {
    const problem = contentVersionProblem(snippet.version);
    if (problem === undefined) {
      collected.push(snippet);
    } else {
      state.violations.push(
        `Plugin "${plugin.name}" (${plugin.id}) snippet "${snippet.id}" ${problem}.`,
      );
    }
  }
}

/**
 * Directory ids are global, like adapter ids: `directory:agenticskills` names a place, so two
 * plugins registering it must collide rather than coexist under separate namespaces.
 */
function collectSkillDirectories(
  state: RegistryState,
  plugin: AuraPlugin,
  collected: DirectorySkillSource[],
): void {
  for (const source of plugin.skillDirectories ?? []) {
    const problem = directorySourceProblem(source);
    if (problem !== undefined) {
      state.violations.push(
        `Plugin "${plugin.name}" (${plugin.id}) skill directory "${source.id}" ${problem}.`,
      );
      continue;
    }
    if (claimId(state, "skill-directory", source.id, plugin)) {
      collected.push(source);
    }
  }
}

function collectSkills(
  state: RegistryState,
  plugin: AuraPlugin,
  collected: RegisteredSkillPack[],
): void {
  const source: BundledSkillSource = {
    id: `plugin:${plugin.id}`,
    kind: "bundled",
    name: plugin.name,
  };
  for (const skill of plugin.skills ?? []) {
    if (skillIdProblem(skill.id) !== undefined) {
      state.violations.push(
        `Plugin "${plugin.name}" (${plugin.id}) contributes skill-pack ID "${skill.id}"; ` +
          "expected a kebab-case local skill ID of at most 64 characters.",
      );
      continue;
    }
    const versionProblem = contentVersionProblem(skill.version);
    if (versionProblem !== undefined) {
      state.violations.push(
        `Plugin "${plugin.name}" (${plugin.id}) skill "${skill.id}" ${versionProblem}.`,
      );
      continue;
    }
    const identity = `${source.id}/${skill.id}`;
    if (claimId(state, "skill-pack", identity, plugin)) {
      collected.push({ skill, source });
    }
  }
}
