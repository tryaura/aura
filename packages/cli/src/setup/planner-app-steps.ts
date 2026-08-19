import { catalogEntryId, catalogEntryName } from "./catalog.js";
import type { SetupStepContext } from "./types.js";

/**
 * Summary lines the plan cannot express as file operations: installing an app Aura does not
 * install itself, and what unchecking a previously-managed app does — the manifest flips to
 * `managed: false` while the app's own configuration stays in place (ownership cleanup is a later
 * milestone).
 */
export function appManualSteps(context: SetupStepContext): readonly string[] {
  const apps = context.selections.apps;
  if (apps === undefined) {
    return [];
  }
  return [...installSteps(context, apps.managed), ...stopManagingSteps(context, apps.managed)];
}

function installSteps(context: SetupStepContext, managed: readonly string[]): readonly string[] {
  const steps: string[] = [];
  for (const id of managed) {
    const entry = context.appCatalog.find((candidate) => catalogEntryId(candidate) === id);
    if (entry?.kind === "undetected") {
      steps.push(
        entry.installHint === undefined
          ? `Install ${entry.displayName} — its adapter provides no install instructions.`
          : `Install ${entry.displayName}: ${entry.installHint}`,
      );
    }
  }
  return steps;
}

function stopManagingSteps(
  context: SetupStepContext,
  managed: readonly string[],
): readonly string[] {
  const previous = context.manifest.status === "ready" ? context.manifest.value.apps : {};
  const managedIds = new Set(managed);
  const steps: string[] = [];
  for (const [id, app] of Object.entries(previous)) {
    const entry = context.appCatalog.find((candidate) => catalogEntryId(candidate) === id);
    if (entry !== undefined && app.managed && !managedIds.has(id)) {
      steps.push(
        `Aura stops managing ${catalogEntryName(entry)}; its existing configuration is left in place.`,
      );
    }
  }
  return steps;
}
