import { defineCheck, type DetectedFinding, type WorkspaceModel } from "@tryaura/aura-sdk";

const CHECK_ID = "MGD-003";

/**
 * Deliberately manual: the only resolution is a full `setup` run.
 *
 * Recording the decision means asking the apps picker, and this check must never start a nested
 * command. Declaring it fixable would open an interactive fix on a single choice that changes
 * nothing — a prompt whose only answer leaves the finding exactly where it was — so the next step
 * is carried on the finding itself instead.
 */
export const unmanagedDetectedAppCheck = defineCheck({
  defaultSeverity: "info",
  detect: detectUnmanagedApps,
  explain:
    "Aura can inspect an installed agent application without managing it. This informational check highlights detected applications that have never been accepted or ignored in the Aura manifest.\n\nRun `aura setup` to add the application, or leave it unchecked once to record that Aura should ignore it. There is no automatic fix: the decision belongs to the apps step, and this check never starts a nested command.",
  fixability: "manual",
  id: CHECK_ID,
  scope: "global",
  title: "Detected applications have an explicit Aura management decision",
});

function detectUnmanagedApps(model: WorkspaceModel): readonly DetectedFinding[] {
  const apps = model.manifest.status === "ready" ? model.manifest.value.apps : {};
  const ignored = new Set(
    model.manifest.status === "ready" ? (model.manifest.value.ignoredApps ?? []) : [],
  );
  return model.apps.flatMap((app) => {
    if (
      app.synthetic === true ||
      Object.hasOwn(apps, app.adapterId) ||
      ignored.has(app.adapterId)
    ) {
      return [];
    }
    return [
      {
        details: `Run \`aura setup\` and select ${app.displayName} to manage it, or leave it unchecked to record an ignored-app decision.`,
        id: app.adapterId,
        message: `${app.displayName} detected but not managed — run \`aura setup\` to add it.`,
        metadata: { appId: app.adapterId },
      },
    ];
  });
}
