import type { Adapter } from "./adapter.js";
import type { Check } from "./check.js";
import type { McpServerDef, Preset, SkillPack, SkillSource, Snippet } from "./content.js";

export interface AuraPlugin {
  readonly adapters?: readonly Adapter[];
  readonly apiVersion: 1;
  readonly checks?: readonly Check[];
  readonly mcpCatalog?: readonly McpServerDef[];
  readonly name: string;
  readonly presets?: readonly Preset[];
  readonly skills?: readonly SkillPack[];
  readonly skillSources?: readonly SkillSource[];
  readonly snippets?: readonly Snippet[];
}
