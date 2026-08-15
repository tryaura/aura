import type { Adapter } from "./adapter.js";
import type { Check } from "./check.js";
import type { McpServerDef, Preset, SkillPack, SkillSource, Snippet } from "./content.js";

/**
 * Everything a plugin contributes to an Aura distribution.
 *
 * Every contribution slot is optional; a plugin may supply only checks, only content, or any
 * combination. Aura core loads a plugin the same way it loads any dependency, and a plugin runs
 * with the full privileges of the process: {@link Adapter.detect} and the {@link SkillSource}
 * methods can execute commands. Install plugins you trust as you would any other dependency.
 *
 * The declarative shapes elsewhere in this SDK — pure checks, data-only {@link FixPlan}s — exist
 * so that Aura can preview, batch, and undo changes, not to sandbox plugin code.
 */
export interface AuraPlugin {
  /** Applications this plugin teaches Aura to read. */
  readonly adapters?: readonly Adapter[] | undefined;
  /**
   * The SDK contract this plugin was written against.
   *
   * Aura v1 loads only `1` and refuses anything else, so a plugin built for a future SDK fails
   * loudly at load time instead of misbehaving at run time.
   */
  readonly apiVersion: 1;
  /** Rules this plugin evaluates against the workspace. */
  readonly checks?: readonly Check[] | undefined;
  /**
   * Stable plugin identifier, unique across a distribution.
   *
   * Every contribution id must be namespaced under it, such as `"acme/rules"` for plugin `"acme"`.
   */
  readonly id: string;
  /** MCP server definitions this plugin offers for installation. */
  readonly mcpCatalog?: readonly McpServerDef[] | undefined;
  /** Human-readable plugin name, shown in reports. */
  readonly name: string;
  /** Bundles of contributions installable in one step. */
  readonly presets?: readonly Preset[] | undefined;
  /** Skill directories bundled with this plugin. */
  readonly skills?: readonly SkillPack[] | undefined;
  /** Drivers that discover skills outside this plugin's package. */
  readonly skillSources?: readonly SkillSource[] | undefined;
  /** Markdown fragments this plugin offers for installation. */
  readonly snippets?: readonly Snippet[] | undefined;
  /** Semver version of the plugin, reported alongside findings it produces. */
  readonly version: string;
}
