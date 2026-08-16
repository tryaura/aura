import type {
  AuraManifest,
  AuraManifestApp,
  AuraManifestState,
  FileOperation,
  FixPlan,
} from "@tryaura/aura-sdk";
import { createAuraManifestWriteOperation, createEmptyAuraManifest } from "@tryaura/core";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";

import { catalogEntryId, catalogEntryName, type AppCatalogEntry } from "./catalog.js";
import type { SetupSelections, SetupStepContext } from "./types.js";

/** A file the plan refuses to touch, and the reason the user can act on. */
export interface SetupBlocker {
  readonly path: string;
  readonly reason: string;
}

export interface SetupPlanOutcome {
  readonly blockers: readonly SetupBlocker[];
  /** The desired state the plan persists, recomputed from scratch every run. */
  readonly manifest: AuraManifest;
  readonly plan: FixPlan;
}

/**
 * Turns the final selections into the one fix plan `setup` applies.
 *
 * Pure and total: it always emits the full desired state rather than a delta, so a machine that
 * already matches previews as all-noop and "first run and fifth run are the same flow" needs no
 * memory of previous runs. Files whose read hit a problem are returned as blockers with their
 * operations omitted — the kernel would conflict on them anyway, but a blocker names the reason
 * where the user decides, not after confirmation.
 */
export function planSetup(context: SetupStepContext): SetupPlanOutcome {
  const blockers: SetupBlocker[] = [];
  const operations: FileOperation[] = [];
  const apps = context.selections.apps;
  const manifest = desiredManifest(context.manifest, apps, context.appCatalog);
  const baseline = context.selections.baseline;

  if (context.manifest.status === "read-only") {
    blockers.push({ path: context.manifest.path, reason: context.manifest.problem.message });
  } else if (
    context.manifest.status === "ready" ||
    baseline?.createManifest === true ||
    (apps !== undefined && apps.managed.length > 0)
  ) {
    operations.push(createAuraManifestWriteOperation(context.manifest, manifest));
  }

  const shared = context.model.sharedInstructions;
  if (shared.problem !== undefined) {
    blockers.push({
      path: shared.path,
      reason: `Aura could not safely read this path (${shared.problem}) and will not overwrite it.`,
    });
  } else if (baseline?.createSharedInstructions === true) {
    operations.push({
      content: SHARED_INSTRUCTIONS_TEMPLATE,
      mode: 0o644,
      path: shared.path,
      type: "write",
    });
  }

  return Object.freeze({
    blockers: Object.freeze(blockers),
    manifest,
    plan: Object.freeze({
      manualSteps: Object.freeze(appManualSteps(context)),
      operations: Object.freeze(operations),
      summary: "Set up Aura on this machine from your selections.",
    }),
  });
}

function desiredManifest(
  state: AuraManifestState,
  apps: SetupSelections["apps"],
  appCatalog: readonly AppCatalogEntry[],
): AuraManifest {
  const base = state.status === "ready" ? state.value : createEmptyAuraManifest();
  if (apps === undefined) {
    return base;
  }

  const available = new Set(appCatalog.map(catalogEntryId));
  const managed = new Set(apps.managed.filter((id) => available.has(id)));
  const next = new Map<string, AuraManifestApp>();
  for (const [id, entry] of Object.entries(base.apps)) {
    // Apps unavailable in this build cannot be selected, so preserve their previous state.
    next.set(id, { ...entry, managed: available.has(id) ? managed.has(id) : entry.managed });
  }
  for (const id of managed) {
    if (!next.has(id)) {
      next.set(id, { managed: true });
    }
  }
  // Object.fromEntries defines special keys such as `__proto__` as own data properties.
  return { ...base, apps: Object.fromEntries(next) };
}

/**
 * Summary lines the plan cannot express as file operations: installing an app Aura does not
 * install itself, and what unchecking a previously-managed app does — the manifest flips to
 * `managed: false` while the app's own configuration stays in place (ownership cleanup is a later
 * milestone).
 */
function appManualSteps(context: SetupStepContext): readonly string[] {
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
