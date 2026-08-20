import type { Adapter, AuraPlugin } from "@tryaura/aura-sdk";

import { canonicalSemver } from "./plugin-validation-version.js";
import { sharedLinkViolations } from "./workspace/shared-links.js";

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

/**
 * The kinds of contribution the registry tracks ownership for.
 *
 * Values match the `kind` discriminants the SDK already puts on content contributions, so the same
 * word names a contribution in an error message, in a `PluginRegistry.ownerOf` lookup, and on the
 * contribution itself.
 */
export type ContributionKind =
  | "adapter"
  | "check"
  | "mcp-server"
  | "plugin"
  | "preset"
  | "skill-directory"
  | "skill-pack"
  | "skill-source"
  | "snippet";

/**
 * Ownership claimed so far, and every problem found so far.
 *
 * Validation accumulates rather than throwing on the first failure, so a distribution with several
 * mistakes is fixed in one pass rather than one rebuild per mistake.
 */
export interface RegistryState {
  readonly owners: Map<ContributionKind, Map<string, AuraPlugin>>;
  readonly violations: string[];
}

interface PluginIdentity {
  readonly id: string;
  readonly name: string;
}

interface Contribution {
  readonly id: string;
}

/** Plugin ids become id namespaces, so `/` and anything shell- or path-surprising is refused. */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function createRegistryState(): RegistryState {
  return { owners: new Map(), violations: [] };
}

export function isSupportedPlugin(candidate: PluginCandidate): candidate is AuraPlugin {
  return candidate.apiVersion === SUPPORTED_PLUGIN_API_VERSION;
}

/** Validates each contribution's namespace and collects the ones that claimed their id. */
export function collectNamespaced<TContribution extends Contribution>(
  state: RegistryState,
  kind: ContributionKind,
  contributions: readonly TContribution[] | undefined,
  plugin: AuraPlugin,
  collected: TContribution[],
): void {
  for (const contribution of contributions ?? []) {
    if (claimNamespacedId(state, kind, contribution.id, plugin)) {
      collected.push(contribution);
    }
  }
}

/** Collects contributions whose ids are global rather than namespaced by the owning plugin. */
export function collectUnnamespaced<TContribution extends Contribution>(
  state: RegistryState,
  kind: ContributionKind,
  contributions: readonly TContribution[] | undefined,
  plugin: AuraPlugin,
  collected: TContribution[],
): void {
  for (const contribution of contributions ?? []) {
    if (claimId(state, kind, contribution.id, plugin)) {
      collected.push(contribution);
    }
  }
}

/** Collects checks, allowing bare ids only for a plugin the distribution granted that privilege. */
export function collectChecks<TContribution extends Contribution>(
  state: RegistryState,
  contributions: readonly TContribution[] | undefined,
  plugin: AuraPlugin,
  allowsBareIds: boolean,
  collected: TContribution[],
): void {
  for (const contribution of contributions ?? []) {
    if (claimCheckId(state, contribution.id, plugin, allowsBareIds)) {
      collected.push(contribution);
    }
  }
}

/**
 * Rejects a bare-check-id grant naming a plugin that is not loaded.
 *
 * A stale or misspelled entry would otherwise withdraw the privilege silently, and the plugin that
 * expected it would fail later with a namespace error that never mentions the grant.
 */
export function collectUnknownBareCheckIdPlugins(
  state: RegistryState,
  bareCheckIdPlugins: ReadonlySet<string>,
  candidates: readonly PluginCandidate[],
): void {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  for (const pluginId of bareCheckIdPlugins) {
    if (!candidateIds.has(pluginId)) {
      state.violations.push(
        `bareCheckIdPlugins names "${pluginId}", which no loaded plugin declares as its ID; ` +
          `remove the entry or correct the plugin ID.`,
      );
    }
  }
}

/** Reports every malformed identity field, and answers whether the plugin is worth reading on. */
export function collectIdentityViolations(state: RegistryState, plugin: AuraPlugin): boolean {
  const violationCount = state.violations.length;

  if (!PLUGIN_ID_PATTERN.test(plugin.id)) {
    state.violations.push(
      `Plugin "${plugin.name}" declares ID "${plugin.id}", which cannot be used as an ID ` +
        `namespace; expected lowercase letters, digits, ".", "-", or "_", starting with a letter ` +
        `or digit.`,
    );
  }

  if (plugin.name.trim().length === 0) {
    state.violations.push(
      `Plugin "${plugin.id}" declares an empty name; reports identify plugins by name.`,
    );
  }

  if (canonicalSemver(plugin.version) !== plugin.version) {
    state.violations.push(
      `${formatPlugin(plugin)} declares version "${plugin.version}"; expected a semver version ` +
        `such as "1.0.0".`,
    );
  }

  return state.violations.length === violationCount;
}

/** Validates write-side adapter data before it can enter a runtime registry. */
export function collectAdapterViolations(
  state: RegistryState,
  adapters: readonly Adapter[] | undefined,
  plugin: AuraPlugin,
): void {
  for (const adapter of adapters ?? []) {
    // Adapter ids are deliberately unnamespaced — they name the application itself — so only the
    // segment grammar is enforced: the same one a plugin id gets, since both end up in paths,
    // reports, and lookups where an empty string or a "/" would be read as structure.
    if (!PLUGIN_ID_PATTERN.test(adapter.id)) {
      state.violations.push(
        `${formatPlugin(plugin)} contributes adapter ID "${adapter.id}", which is not a usable ` +
          `adapter ID; expected lowercase letters, digits, ".", "-", or "_", starting with a ` +
          `letter or digit.`,
      );
    }
    collectSharedLinkCapabilityViolations(state, adapter, plugin);
    for (const [name, scope, link] of [
      ["sharedLink", "global", adapter.sharedLink],
      ["projectSharedLink", "project", adapter.projectSharedLink],
    ] as const) {
      if (link !== undefined) {
        for (const violation of sharedLinkViolations(link, scope)) {
          state.violations.push(
            `${formatPlugin(plugin)} adapter "${adapter.id}" declares invalid ${name}: ${violation}.`,
          );
        }
      }
    }
  }
}

function collectSharedLinkCapabilityViolations(
  state: RegistryState,
  adapter: Adapter,
  plugin: AuraPlugin,
): void {
  if (
    adapter.capabilities?.instructions?.globalSharedLink === "not-applicable" &&
    adapter.sharedLink !== undefined
  ) {
    state.violations.push(
      `${formatPlugin(plugin)} adapter "${adapter.id}" declares both sharedLink and ` +
        `capabilities.instructions.globalSharedLink "not-applicable"; remove one declaration.`,
    );
  }
}

function claimCheckId(
  state: RegistryState,
  id: string,
  plugin: AuraPlugin,
  allowsBareId: boolean,
): boolean {
  if (allowsBareId && id.length > 0 && !id.includes("/")) {
    return claimId(state, "check", id, plugin);
  }

  return claimNamespacedId(state, "check", id, plugin);
}

function claimNamespacedId(
  state: RegistryState,
  kind: ContributionKind,
  id: string,
  plugin: AuraPlugin,
): boolean {
  const namespace = `${plugin.id}/`;
  if (!id.startsWith(namespace) || id.length === namespace.length) {
    state.violations.push(
      `${formatPlugin(plugin)} contributes ${kind} ID "${id}"; ` +
        `expected the "${namespace}<id>" namespace.`,
    );
    return false;
  }

  return claimId(state, kind, id, plugin);
}

export function claimId(
  state: RegistryState,
  kind: ContributionKind,
  id: string,
  plugin: AuraPlugin,
): boolean {
  let kindOwners = state.owners.get(kind);
  if (kindOwners === undefined) {
    kindOwners = new Map();
    state.owners.set(kind, kindOwners);
  }

  const existingOwner = kindOwners.get(id);
  if (existingOwner) {
    state.violations.push(
      `${formatPlugin(plugin)} contributes duplicate ${kind} ID "${id}"; ` +
        `already registered by ${formatPlugin(existingOwner)}.`,
    );
    return false;
  }

  kindOwners.set(id, plugin);
  return true;
}

export function formatApiVersionViolation(candidate: PluginCandidate): string {
  const remedy =
    candidate.apiVersion > SUPPORTED_PLUGIN_API_VERSION
      ? "Upgrade Aura, or install a plugin release built against"
      : "Upgrade the plugin to a release built against";

  return (
    `${formatPlugin(candidate)} uses unsupported apiVersion ${candidate.apiVersion}; ` +
    `this Aura build supports apiVersion ${SUPPORTED_PLUGIN_API_VERSION}. ` +
    `${remedy} apiVersion ${SUPPORTED_PLUGIN_API_VERSION}.`
  );
}

export function formatViolations(violations: readonly string[]): string {
  const heading =
    violations.length === 1
      ? "Aura cannot build the plugin registry:"
      : `Aura cannot build the plugin registry (${violations.length} problems):`;

  return [heading, ...violations.map((violation) => `  - ${violation}`)].join("\n");
}

function formatPlugin(plugin: PluginIdentity): string {
  return `Plugin "${plugin.name}" (${plugin.id})`;
}
