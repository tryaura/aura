import type { SetupStepContext } from "./types.js";

/** Managed ids from this wizard pass, falling back to the persisted selection for targeted runs. */
export function managedAppIdList(context: SetupStepContext): readonly string[] {
  if (context.selections.apps !== undefined) {
    return context.selections.apps.managed;
  }
  return context.manifest.status === "ready"
    ? Object.entries(context.manifest.value.apps)
        .filter(([, app]) => app.managed)
        .map(([id]) => id)
    : [];
}
