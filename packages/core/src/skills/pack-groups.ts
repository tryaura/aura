import { fileURLToPath } from "node:url";

import type { AuraPresetSkillSelection, Preset } from "@tryaura/aura-sdk";

import { validateTeamPreset } from "../preset/schema.js";
import { MAX_TEAM_PRESET_BYTES } from "../workspace/reader-limits.js";
import { createFileReader } from "../workspace/reader.js";

/**
 * One plugin-shipped preset offered as a checkable group of skills in the picker.
 *
 * A pack is a selection gesture, not a policy layer: checking it checks its member rows, every
 * remote member still passes its own Review with Skip as the initial answer, and a non-interactive
 * run takes nothing from it. The preset document's other fields (directories, checks, required
 * servers) apply only when the preset is configured as the run's policy layer — a pack never
 * smuggles them in.
 */
export interface SkillPackGroup {
  readonly description: string;
  /** The plugin-namespaced preset id, such as `official/starter`. */
  readonly id: string;
  readonly name: string;
  readonly skills: readonly AuraPresetSkillSelection[];
}

export interface SkillPackGroupsResult {
  readonly groups: readonly SkillPackGroup[];
  /** One line per preset that could not be offered, in the house voice. */
  readonly notes: readonly string[];
}

/**
 * Reads every registry preset that declares skills into a pack group.
 *
 * A preset that cannot be read or does not validate is dropped with a note naming it — a pack
 * that silently vanishes is indistinguishable from one that was never shipped. A valid preset
 * with no skill selection is not a pack at all (it is a policy document) and is skipped silently.
 */
export async function loadSkillPackGroups(
  presets: readonly Preset[],
): Promise<SkillPackGroupsResult> {
  const reader = createFileReader();
  const groups: SkillPackGroup[] = [];
  const notes: string[] = [];
  for (const preset of presets) {
    const outcome = await loadGroup(preset, reader);
    if (typeof outcome === "string") {
      notes.push(`Skill pack "${preset.id}" ${outcome}, so it is not offered.`);
      continue;
    }
    if (outcome !== undefined) {
      groups.push(outcome);
    }
  }
  return { groups: Object.freeze(groups), notes: Object.freeze(notes) };
}

/** The group, `undefined` for a skill-less policy preset, or the reason fragment for its note. */
async function loadGroup(
  preset: Preset,
  reader: ReturnType<typeof createFileReader>,
): Promise<SkillPackGroup | string | undefined> {
  const document = await readPresetDocument(preset, reader);
  if (typeof document === "string") {
    return document;
  }
  const validated = validateTeamPreset(document.parsed);
  if (validated.kind === "invalid") {
    return `is not a valid preset (${validated.problem})`;
  }
  const skills = validated.preset.skills ?? [];
  if (skills.length === 0) {
    return undefined;
  }
  return Object.freeze({
    description: preset.description,
    id: preset.id,
    name: preset.name,
    skills,
  });
}

/** The parsed JSON document, or the reason fragment it could not be read. */
async function readPresetDocument(
  preset: Preset,
  reader: ReturnType<typeof createFileReader>,
): Promise<{ readonly parsed: unknown } | string> {
  let path: string;
  try {
    const url = new URL(preset.source.url);
    if (url.protocol !== "file:") {
      return "does not use a file: source";
    }
    path = fileURLToPath(url);
  } catch {
    return "has an invalid source";
  }
  const contents = await reader.read(path, { maxBytes: MAX_TEAM_PRESET_BYTES });
  if (!contents.exists || contents.problem !== undefined || contents.content === undefined) {
    return "could not be read";
  }
  try {
    return { parsed: JSON.parse(contents.content) };
  } catch {
    return "is not valid JSON";
  }
}
