import type { AuraTeamPreset, DirectorySkillSource, SkillSourceId } from "@tryaura/aura-sdk";

import type { ScanDiagnostic } from "../workspace/diagnostics.js";

const SOURCES_DIAGNOSTIC_ID = "core/skill-directory";

/** Every directory the current run may talk to, after merge and allowlist filtering. */
export interface CollectedSkillDirectories {
  readonly diagnostics: readonly ScanDiagnostic[];
  readonly sources: readonly DirectorySkillSource[];
}

/**
 * Merges plugin-registered directories with preset-defined ones and applies the allowlist.
 *
 * A registered directory wins an id collision: the registry entry is build-time configuration the
 * distribution vouched for, while the preset travels with a checkout. Sources the allowlist
 * refuses are dropped here, before anything lists or fetches them — a refused source is never
 * shown, never probed, never named in a picker.
 */
export function collectSkillDirectorySources(
  registered: readonly DirectorySkillSource[],
  preset: AuraTeamPreset | undefined,
): CollectedSkillDirectories {
  const diagnostics: ScanDiagnostic[] = [];
  const merged = new Map<string, DirectorySkillSource>();

  for (const source of registered) {
    merged.set(source.id, source);
  }
  for (const source of preset?.skillDirectories ?? []) {
    if (merged.has(source.id)) {
      diagnostics.push({
        adapterId: SOURCES_DIAGNOSTIC_ID,
        message:
          `Team preset skill directory "${source.id}" duplicates a registered directory, ` +
          "so the registered one is used.",
        phase: "read",
      });
      continue;
    }
    merged.set(source.id, source);
  }

  return {
    diagnostics: Object.freeze(diagnostics),
    sources: Object.freeze(
      [...merged.values()].filter((source) => isSkillSourceAllowed(preset, source.id)),
    ),
  };
}

/** Whether the preset permits installing from this source. An absent allowlist permits all. */
export function isSkillSourceAllowed(
  preset: AuraTeamPreset | undefined,
  id: SkillSourceId,
): boolean {
  const allowed = preset?.allowedSkillSources;
  return allowed === undefined || allowed.includes(id);
}
