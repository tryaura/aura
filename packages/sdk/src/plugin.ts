import type { Adapter } from "./adapter.js";
import type { Check } from "./check.js";
import type {
  DirectorySkillSource,
  McpServerDef,
  Preset,
  SkillPack,
  SkillSourceId,
  SkillSourceDriver,
  Snippet,
} from "./content.js";
// eslint-disable-next-line no-unused-vars -- Imported so TSDoc links resolve to the public symbol.
import type { FixPlan } from "./fix.js";

/**
 * Everything a plugin contributes to an Aura distribution.
 *
 * Every contribution slot is optional; a plugin may supply only checks, only content, or any
 * combination. Aura core loads a plugin the same way it loads any dependency, and a plugin runs
 * with the full privileges of the process: {@link Adapter.detect} and the {@link SkillSourceDriver}
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
   * Aura loads only the version this build supports and refuses anything else, so a plugin built
   * for a different SDK fails loudly at load time instead of misbehaving at run time.
   *
   * `2` dropped `Adapter.projectSharedLink`, `scope` from `AuraManifestMcpServer`,
   * `OwnedServerEntry`, `InstalledSkill`, and `ResolvedSkillDirectory`, and required every
   * `capabilities.skills.directories` entry to be a `~/...` path. A plugin still declaring `1`
   * cannot satisfy those rules, which is why the number moved rather than the registry guessing.
   */
  readonly apiVersion: 2;
  /** Rules this plugin evaluates against the workspace. */
  readonly checks?: readonly Check[] | undefined;
  /** Exact source IDs this plugin removes from the distribution when they are present. */
  readonly disabledSkillSources?: readonly SkillSourceId[] | undefined;
  /**
   * Stable plugin identifier, unique across a distribution.
   *
   * Lowercase letters, digits, `.`, `-`, and `_`, starting with a letter or digit. Checks,
   * snippets, MCP servers, presets, and skill source drivers are namespaced under it, such as
   * `"acme/rules"`. Bundled skills use source-local IDs; adapters name applications globally.
   */
  readonly id: string;
  /** MCP server definitions this plugin offers for installation. */
  readonly mcpCatalog?: readonly McpServerDef[] | undefined;
  /** Human-readable plugin name, shown in reports. */
  readonly name: string;
  /** Bundles of contributions installable in one step. */
  readonly presets?: readonly Preset[] | undefined;
  /**
   * Remote skill directories this plugin registers with Aura's built-in directory client.
   *
   * Ids are global (`directory:agenticskills`) rather than plugin-namespaced: a directory names a
   * place, and two plugins pointing Aura at the same id must collide, not coexist.
   */
  readonly skillDirectories?: readonly DirectorySkillSource[] | undefined;
  /** Skill directories bundled with this plugin. */
  readonly skills?: readonly SkillPack[] | undefined;
  /** Lazy interactive-setup drivers that discover skills outside this plugin's package. */
  readonly skillSources?: readonly SkillSourceDriver[] | undefined;
  /** Markdown fragments this plugin offers for installation. */
  readonly snippets?: readonly Snippet[] | undefined;
  /** Semver version of the plugin, reported alongside findings it produces. */
  readonly version: string;
}
