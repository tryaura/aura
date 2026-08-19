import type { SetupNotice } from "./planner.js";
import type { SetupStepContext } from "./types.js";

/**
 * The preset's own check settings, shown as read-only policy.
 *
 * The preset is named once in the group heading rather than on every line: with a preset that
 * configures a dozen checks, a repeated "(from preset acme)" is noise that hides the settings the
 * user is actually meant to read.
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
