import type {
  AuraEffectiveConfig,
  AuraTeamPreset,
  Environment,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import type { PluginRegistry } from "@tryaura/core";

import { createMcpSetupCatalog, type McpSetupCatalog } from "./mcp-catalog.js";
import { createSkillCatalog, type SkillCatalog } from "./skills-catalog.js";

/** Everything the run's steps choose from, once configuration has already been resolved. */
export interface SetupCatalogs {
  readonly mcpCatalog: McpSetupCatalog;
  readonly skillCatalog: SkillCatalog;
}

interface SetupCatalogInputs {
  readonly config: AuraEffectiveConfig;
  readonly environment: Environment;
  /** Whether this run may call a skill-source driver, which is the one source kind running code. */
  readonly interactive: boolean;
  readonly model: WorkspaceModel;
  /** Bypass catalog cache reads and writes, mirroring the preset loader's `--no-cache`. */
  readonly noCache?: boolean | undefined;
  readonly preset: AuraTeamPreset | undefined;
  /** Messages from resolving the configuration, surfaced with the catalogs' own notes. */
  readonly presetNotes: readonly string[];
  /** Where the active policy came from, in the words a user should see. */
  readonly presetOrigin: string;
  readonly registry: PluginRegistry;
}

/**
 * Builds the catalogs that depend on the resolved configuration.
 *
 * The preset is loaded during boot rather than here, so an unresolvable one has already stopped
 * the run: by the time pickers are assembled there is nothing left to fail on.
 */
export function createSetupCatalogs(inputs: SetupCatalogInputs): SetupCatalogs {
  return {
    mcpCatalog: createMcpSetupCatalog({
      model: inputs.model,
      preset: requiringPreset(inputs.preset, inputs.config),
      registry: inputs.registry,
    }),
    skillCatalog: createSkillCatalog({
      environment: inputs.environment,
      interactive: inputs.interactive,
      model: inputs.model,
      noCache: inputs.noCache,
      preset: inputs.preset,
      presetNotes: [...inputs.presetNotes, ...disabledSourceNotes(inputs.registry)],
      presetOrigin: inputs.presetOrigin,
      registryDirectories: inputs.registry.skillDirectories,
      registryDrivers: inputs.registry.skillSources,
      registryPresets: inputs.registry.presets,
    }),
  };
}

/**
 * Names the plugin behind every skill source this distribution removed.
 *
 * A denylist that fires silently is indistinguishable from a source that broke: the row is simply
 * not there. Only removals that actually matched something are reported, so a distribution that
 * disables a source it never shipped says nothing at all.
 */
function disabledSourceNotes(registry: PluginRegistry): readonly string[] {
  return [...registry.disabledSkillSources].map(
    ([id, pluginId]) => `Skill source "${id}" is not offered: plugin "${pluginId}" disables it.`,
  );
}

/**
 * Restates the effective required servers on the policy preset the MCP catalog reads.
 *
 * Requirements can arrive from any layer, not only the preset document, and the picker marks a row
 * required from one list — so the resolved list is what it has to be given.
 */
function requiringPreset(
  preset: AuraTeamPreset | undefined,
  config: AuraEffectiveConfig,
): AuraTeamPreset | undefined {
  const requiredMcpServers = config.requiredMcpServers.map(({ value }) => value);
  if (requiredMcpServers.length === 0) {
    return preset;
  }
  return Object.freeze({ ...preset, requiredMcpServers, schemaVersion: 1 as const });
}
