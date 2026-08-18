import type {
  AuraConfigurationLayer,
  AuraConfigurationProvenance,
  AuraEffectiveValue,
  AuraPresetSkillSelection,
  DirectorySkillSource,
  SkillSourceId,
} from "@tryaura/aura-sdk";

/** One configuration layer paired with the provenance every value it wins carries. */
export interface NamedLayer {
  readonly config: AuraConfigurationLayer;
  readonly provenance: AuraConfigurationProvenance;
}

export function lastAllowedSources(layers: readonly NamedLayer[]): {
  readonly allowedSkillSources?: AuraEffectiveValue<readonly SkillSourceId[]> | undefined;
} {
  let result: AuraEffectiveValue<readonly SkillSourceId[]> | undefined;
  for (const layer of layers) {
    if (layer.config.allowedSkillSources !== undefined) {
      result = effective(Object.freeze([...layer.config.allowedSkillSources]), layer.provenance);
    }
  }
  return result === undefined ? {} : { allowedSkillSources: result };
}

export function collectValues(
  layers: readonly NamedLayer[],
  key: "requiredMcpServers",
): readonly AuraEffectiveValue<string>[];
export function collectValues(
  layers: readonly NamedLayer[],
  key: "skillDirectories",
): readonly AuraEffectiveValue<DirectorySkillSource>[];
export function collectValues(
  layers: readonly NamedLayer[],
  key: "requiredMcpServers" | "skillDirectories",
): readonly AuraEffectiveValue<DirectorySkillSource | string>[] {
  const result = new Map<string, AuraEffectiveValue<DirectorySkillSource | string>>();
  for (const layer of layers) {
    const values = layer.config[key] ?? [];
    for (const value of values) {
      const identity = typeof value === "string" ? value : value.id;
      const immutable = typeof value === "string" ? value : Object.freeze({ ...value });
      result.set(identity, effective(immutable, layer.provenance));
    }
  }
  return Object.freeze([...result.values()]);
}

export function lastValues(
  layers: readonly NamedLayer[],
  key: "snippets",
): readonly AuraEffectiveValue<string>[];
export function lastValues(
  layers: readonly NamedLayer[],
  key: "skills",
): readonly AuraEffectiveValue<AuraPresetSkillSelection>[];
export function lastValues(
  layers: readonly NamedLayer[],
  key: "skills" | "snippets",
): readonly AuraEffectiveValue<AuraPresetSkillSelection | string>[] {
  let result: readonly AuraEffectiveValue<AuraPresetSkillSelection | string>[] = [];
  for (const layer of layers) {
    const values = layer.config[key];
    if (values !== undefined) {
      result = Object.freeze(
        values.map((value) =>
          effective(
            typeof value === "string" ? value : Object.freeze({ ...value }),
            layer.provenance,
          ),
        ),
      );
    }
  }
  return result;
}

function effective<T>(value: T, source: AuraConfigurationProvenance): AuraEffectiveValue<T> {
  return Object.freeze({ provenance: source, value });
}
