import { sortForDisplay } from "../display-order.js";
import { hasSkillsHome, skillSupportMatrix } from "../skill-app-support.js";
import { skillIdentity } from "../skill-planner-paths.js";
import { describePresetPolicy } from "../skill-planner-policy.js";
import type { WizardOption } from "../wizard-types.js";
import type { SkillStageInputs } from "./skill-stages.js";

/**
 * The picker's question line, which is where the support matrix belongs.
 *
 * Support is a property of the run, not of any one skill, so it is stated once above the rows
 * instead of on every row — a per-row copy wraps each description onto a second terminal row and
 * halves how many skills the window can show at a time.
 */
export function pickerPrompt(inputs: SkillStageInputs): string {
  const matrix = skillSupportMatrix(inputs.managedApps);
  if (hasSkillsHome(inputs.managedApps)) {
    return `Which skills should Aura install to the shared skills directory? ${matrix}`;
  }
  return (
    "No selected application supports Agent Skills, so nothing new can be installed — clear an " +
    `installed skill to remove it. ${matrix}`
  );
}

export function pickerOptions(inputs: SkillStageInputs): readonly WizardOption[] {
  const covered = new Set(inputs.listing.entries.map((entry) => entry.identity));
  const unavailableById = new Map(
    inputs.listing.unavailableSources.map((source) => [source.id, source]),
  );
  const policy = inputs.catalog.policy;
  const unsupported = !hasSkillsHome(inputs.managedApps);
  const preset = new Set(inputs.presetSkills.map((skill) => skillIdentity(skill.source, skill.id)));

  const entryRows = sortForDisplay(inputs.listing.entries, (entry) => [
    entry.sourceName,
    entry.name,
    entry.id,
  ]).map((entry): WizardOption => ({
    description: `${entry.description} · v${entry.version}`,
    get disabled() {
      return unsupported || inputs.listing.verification?.isMissing(entry.identity) === true;
    },
    get disabledNote() {
      if (unsupported) {
        return "no selected app supports skills";
      }
      return inputs.listing.verification?.isMissing(entry.identity) === true
        ? "source no longer publishes this skill"
        : undefined;
    },
    group: entry.sourceName,
    label: `${entry.name}${preset.has(entry.identity) ? " (from preset)" : ""}`,
    ...(entry.preview === undefined ? {} : { preview: entry.preview }),
    value: entry.identity,
  }));

  const manifestRows = inputs.manifestSkills.flatMap((skill): readonly WizardOption[] => {
    const identity = skillIdentity(skill.source, skill.id);
    if (covered.has(identity)) {
      return [];
    }
    const unavailable = unavailableById.get(skill.source);
    if (policy.allowedSourceIds !== undefined && !policy.allowedSourceIds.has(skill.source)) {
      return [
        {
          description: `Not allowed by ${describePresetPolicy(policy.presetName)}. Clear it to remove the skill.`,
          disabled: true,
          disabledNote: "blocked by the team preset",
          group: skill.source,
          label: `${skill.id} (blocked)`,
          value: identity,
        },
      ];
    }
    return [
      {
        description:
          unavailable === undefined
            ? "Previously installed, but its source is unavailable. Clear it to remove the skill."
            : `Its source is unavailable (${unavailable.hint}). Clear it to remove the skill.`,
        disabled: true,
        disabledNote: "source unavailable",
        group: unavailable?.name ?? skill.source,
        label: `${skill.id} (preserved)`,
        value: identity,
      },
    ];
  });

  const sourceRows = inputs.listing.unavailableSources
    .filter((source) => inputs.manifestSkills.every((skill) => skill.source !== source.id))
    .map((source): WizardOption => ({
      description: `unavailable (${source.hint})`,
      disabled: true,
      group: source.name,
      label: source.name,
      value: `source:${source.id}`,
    }));

  const represented = new Set([
    ...inputs.listing.entries.map((entry) => entry.identity),
    ...inputs.manifestSkills.map((skill) => skillIdentity(skill.source, skill.id)),
  ]);
  const presetRows = inputs.presetSkills
    .filter((skill) => !represented.has(skillIdentity(skill.source, skill.id)))
    .map((skill): WizardOption => ({
      description: "Selected by the active team preset, but unavailable in this run.",
      disabled: true,
      disabledNote: "preset selection unavailable",
      group: skill.source,
      label: `${skill.id} (from preset)`,
      value: skillIdentity(skill.source, skill.id),
    }));

  // Unavailable sources lead. They are the only rows nothing preselects, so behind the picker's
  // initial row window they would be the one class of row that can fall off the first frame
  // entirely — and a source being down is exactly what has to be visible without searching for it.
  return [...sourceRows, ...entryRows, ...manifestRows, ...presetRows];
}
