import type { Adapter, AuraPlugin, Check, SkillPack, Snippet } from "@tryaura/aura-sdk";

/** The plugin contract supported by this Aura core build. */
export const SUPPORTED_PLUGIN_API_VERSION = 1;

/**
 * A plugin presented to the runtime registry.
 *
 * `definePlugin` keeps `apiVersion` narrowed to the supported SDK literal for authors, while the
 * registry accepts a number so a plugin compiled against another SDK version can fail clearly at
 * startup.
 */
export type PluginCandidate = Omit<AuraPlugin, "apiVersion"> & {
  readonly apiVersion: number;
};

/** Options controlling distribution-owned plugin registry policy. */
export interface PluginRegistryOptions {
  /** Plugins allowed to contribute bare official check ids such as `INS-001`. */
  readonly officialPluginIds?: readonly string[] | undefined;
}

/** Validated plugin contributions available to Aura core. */
export interface PluginRegistry {
  readonly adapters: readonly Adapter[];
  readonly checks: readonly Check[];
  readonly plugins: readonly AuraPlugin[];
  readonly skills: readonly SkillPack[];
  readonly snippets: readonly Snippet[];
}

interface PluginOwner {
  readonly id: string;
  readonly name: string;
}

/** Validates and flattens the build-time plugin list for a distribution. */
export function createPluginRegistry(
  candidates: readonly PluginCandidate[],
  options: PluginRegistryOptions = {},
): PluginRegistry {
  const officialPluginIds = new Set(options.officialPluginIds ?? []);
  const pluginOwners = new Map<string, PluginOwner>();
  const adapterOwners = new Map<string, PluginOwner>();
  const checkOwners = new Map<string, PluginOwner>();
  const snippetOwners = new Map<string, PluginOwner>();
  const skillOwners = new Map<string, PluginOwner>();
  const plugins: AuraPlugin[] = [];
  const adapters: Adapter[] = [];
  const checks: Check[] = [];
  const snippets: Snippet[] = [];
  const skills: SkillPack[] = [];

  for (const candidate of candidates) {
    assertSupportedPlugin(candidate);
    const plugin = candidate;

    registerId(pluginOwners, "plugin", plugin.id, plugin);
    plugins.push(plugin);

    for (const adapter of plugin.adapters ?? []) {
      registerId(adapterOwners, "adapter", adapter.id, plugin);
      adapters.push(adapter);
    }

    for (const check of plugin.checks ?? []) {
      validateCheckId(check.id, plugin, officialPluginIds.has(plugin.id));
      registerId(checkOwners, "check", check.id, plugin);
      checks.push(check);
    }

    for (const snippet of plugin.snippets ?? []) {
      validateNamespacedId("snippet", snippet.id, plugin);
      registerId(snippetOwners, "snippet", snippet.id, plugin);
      snippets.push(snippet);
    }

    for (const skill of plugin.skills ?? []) {
      validateNamespacedId("skill", skill.id, plugin);
      registerId(skillOwners, "skill", skill.id, plugin);
      skills.push(skill);
    }
  }

  return { adapters, checks, plugins, skills, snippets };
}

function assertSupportedPlugin(candidate: PluginCandidate): asserts candidate is AuraPlugin {
  if (candidate.apiVersion !== SUPPORTED_PLUGIN_API_VERSION) {
    throw new Error(
      `${formatPlugin(candidate)} uses unsupported apiVersion ${candidate.apiVersion}; ` +
        `this Aura build supports apiVersion ${SUPPORTED_PLUGIN_API_VERSION}.`,
    );
  }
}

function registerId(
  owners: Map<string, PluginOwner>,
  contribution: string,
  id: string,
  plugin: AuraPlugin,
): void {
  const existingOwner = owners.get(id);
  if (existingOwner) {
    throw new Error(
      `${formatPlugin(plugin)} contributes duplicate ${contribution} ID "${id}"; ` +
        `already registered by ${formatPlugin(existingOwner)}.`,
    );
  }

  owners.set(id, plugin);
}

function validateCheckId(id: string, plugin: AuraPlugin, allowsBareId: boolean): void {
  if (allowsBareId && id.length > 0 && !id.includes("/")) {
    return;
  }

  validateNamespacedId("check", id, plugin);
}

function validateNamespacedId(contribution: string, id: string, plugin: AuraPlugin): void {
  const namespace = `${plugin.id}/`;
  if (id.startsWith(namespace) && id.length > namespace.length) {
    return;
  }

  throw new Error(
    `${formatPlugin(plugin)} contributes ${contribution} ID "${id}"; ` +
      `expected the "${namespace}<id>" namespace.`,
  );
}

function formatPlugin(plugin: PluginOwner): string {
  return `Plugin "${plugin.name}" (${plugin.id})`;
}
