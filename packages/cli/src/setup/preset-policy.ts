import type { AuraConfigurationLayerName, AuraEffectiveConfig } from "@tryaura/aura-sdk";
import { AURA_TEAM_PRESET_PATH } from "@tryaura/core";

import type { SetupNotice } from "./planner.js";
import type { SetupStepContext } from "./types.js";

/**
 * The read-only policy summary for the selected preset's check settings.
 *
 * These lines are informational: the values already apply through configuration resolution, and
 * copying them into the manifest would promote them into user overrides they never were.
 */
export function presetPolicyNotices(context: SetupStepContext): readonly SetupNotice[] {
  const preset = context.preset;
  if (preset === undefined || preset.checkSummary.length === 0) {
    return [];
  }
  return preset.checkSummary.map((message, index) => ({
    ...(index === 0
      ? {
          heading: `Effective check policy from preset ${preset.name} (not copied into your manifest):`,
        }
      : {}),
    kind: "policy",
    message,
  }));
}

/** What the plan summary says about the repository preset: its policy, or why it was not applied. */
export function repoPresetNotices(context: SetupStepContext): readonly SetupNotice[] {
  const repo = context.repoPreset;
  if (repo === undefined) {
    return [];
  }
  if (repo.status === "held") {
    return [
      {
        heading: "Repository preset held (not trusted on this machine):",
        kind: "repo",
        message: `${AURA_TEAM_PRESET_PATH} was not applied. Run setup interactively to review and trust it.`,
      },
    ];
  }
  const recorded: readonly SetupNotice[] = repo.recorded
    ? [
        {
          heading: "Repository preset trust recorded before this plan:",
          kind: "repo",
          message: `Trust of ${AURA_TEAM_PRESET_PATH} is already saved; declining or aborting this plan keeps it.`,
        },
      ]
    : [];
  return [
    ...recorded,
    ...repo.checkSummary.map((message, index): SetupNotice => ({
      ...(index === 0
        ? {
            heading: `Effective check policy from the repository preset ${AURA_TEAM_PRESET_PATH} (not copied into your manifest):`,
          }
        : {}),
      kind: "repo",
      message,
    })),
  ];
}

/** The check values one layer supplied, in the wording the policy summaries share. */
export function presetCheckSummary(
  config: AuraEffectiveConfig,
  layer: AuraConfigurationLayerName,
): readonly string[] {
  const lines: string[] = [];
  for (const [id, check] of Object.entries(config.checks)) {
    if (check.enabled.provenance.layer === layer) {
      lines.push(`${id}: ${check.enabled.value ? "enabled" : "disabled"}`);
    }
    if (check.severity.provenance.layer === layer) {
      lines.push(`${id}: severity ${check.severity.value}`);
    }
    if (check.thresholds.provenance.layer === layer) {
      lines.push(`${id}: ${formatThresholds(check.thresholds.value)}`);
    }
  }
  return Object.freeze(lines);
}

/** Thresholds read as settings, not as the JSON they happen to be stored in. */
function formatThresholds(thresholds: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(thresholds).map(
    ([name, value]) =>
      `${name}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  return pairs.length === 0 ? "no thresholds" : pairs.join(", ");
}
