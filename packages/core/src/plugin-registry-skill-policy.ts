/**
 * The skill-source denylist a distribution's plugins declare, and how it is applied.
 *
 * Kept apart from the registry proper because it is the one contribution that acts on *other*
 * plugins: everything else a plugin declares only adds its own, while this removes something a
 * sibling registered.
 */
import type {
  AuraPlugin,
  DirectorySkillSource,
  SkillSourceDriver,
  SkillSourceId,
} from "@tryaura/aura-sdk";

import type { RegisteredSkillPack } from "./plugin-registry.js";
import type { RegistryState } from "./plugin-validation.js";

/** One accepted denylist entry, paired with the plugin that declared it. */
export interface DisabledSkillSource {
  readonly id: SkillSourceId;
  readonly pluginId: string;
}

/** The source lists a denylist filters, before it is applied. */
export interface RegisteredSkillSources {
  readonly skillDirectories: readonly DirectorySkillSource[];
  readonly skills: readonly RegisteredSkillPack[];
  readonly skillSources: readonly SkillSourceDriver[];
}

/** What survived the denylist, plus the entries that actually removed something. */
export interface FilteredSkillSources extends RegisteredSkillSources {
  /** Source id → the plugin id that removed it; only applied removals appear. */
  readonly disabled: ReadonlyMap<SkillSourceId, string>;
}

const SKILL_SOURCE_ID_PATTERN = /^(?:directory|driver|plugin):[^\s:]+$/u;
const MAX_DISABLED_SKILL_SOURCES = 256;

/** Validates one plugin's exact denylist; targets may be absent from this distribution. */
export function collectDisabledSkillSources(
  state: RegistryState,
  plugin: AuraPlugin,
  collected: DisabledSkillSource[],
): void {
  const sources = plugin.disabledSkillSources ?? [];
  if (sources.length > MAX_DISABLED_SKILL_SOURCES) {
    state.violations.push(
      `Plugin "${plugin.name}" (${plugin.id}) disables more than ${String(MAX_DISABLED_SKILL_SOURCES)} skill sources.`,
    );
    return;
  }
  const seen = new Set<string>();
  for (const source of sources) {
    if (!SKILL_SOURCE_ID_PATTERN.test(source)) {
      state.violations.push(
        `Plugin "${plugin.name}" (${plugin.id}) disables invalid skill source ID "${source}".`,
      );
      continue;
    }
    if (seen.has(source)) {
      state.violations.push(
        `Plugin "${plugin.name}" (${plugin.id}) disables duplicate skill source ID "${source}".`,
      );
      continue;
    }
    seen.add(source);
    collected.push({ id: source, pluginId: plugin.id });
  }
}

/**
 * Removes every denied source, recording which entries had something to remove.
 *
 * Applied over the fully collected lists so an entry does not depend on whether its target's plugin
 * loaded before or after the plugin disabling it. Ownership is claimed during collection and
 * deliberately left standing: a disabled source still reserves its id, so removing one can never let
 * a colliding contribution through that would otherwise have been rejected.
 */
export function applyDisabledSkillSources(
  registered: RegisteredSkillSources,
  entries: readonly DisabledSkillSource[],
): FilteredSkillSources {
  const denied = new Map(entries.map(({ id, pluginId }) => [id, pluginId]));
  const disabled = new Map<SkillSourceId, string>();
  const kept = <T>(items: readonly T[], sourceId: (item: T) => SkillSourceId): T[] =>
    items.filter((item) => {
      const id = sourceId(item);
      const pluginId = denied.get(id);
      if (pluginId === undefined) {
        return true;
      }
      disabled.set(id, pluginId);
      return false;
    });

  return {
    disabled,
    skillDirectories: kept(registered.skillDirectories, (source) => source.id),
    skills: kept(registered.skills, ({ source }) => source.id),
    skillSources: kept(registered.skillSources, (source) => `driver:${source.id}`),
  };
}
