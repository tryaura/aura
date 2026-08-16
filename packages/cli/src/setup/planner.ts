import type {
  AuraManifest,
  AuraManifestApp,
  AuraManifestState,
  FileOperation,
  FixPlan,
} from "@tryaura/aura-sdk";
import { createAuraManifestWriteOperation, createEmptyAuraManifest } from "@tryaura/core";

import { catalogEntryId, catalogEntryName, type AppCatalogEntry } from "./catalog.js";
import { planInstructions } from "./instruction-planner.js";
import { planSnippets } from "./snippet-planner.js";
import type { SetupSelections, SetupStepContext } from "./types.js";

/** A file the plan refuses to touch, and the reason the user can act on. */
export interface SetupBlocker {
  readonly path: string;
  readonly reason: string;
}

/**
 * Something the plan did to content it did not author, reported but never blocking.
 *
 * `overwritten` means a hand edit inside a managed section is being replaced; `preserved` means a
 * tagged section Aura does not own was left where it stood. Both are grouped under their own
 * heading, because "we kept your text" and "we are about to discard it" are opposite messages.
 */
export interface SetupNotice {
  readonly kind: "overwritten" | "preserved";
  readonly message: string;
}

export interface SetupPlanOutcome {
  readonly blockers: readonly SetupBlocker[];
  /** The desired state the plan persists, recomputed from scratch every run. */
  readonly manifest: AuraManifest;
  readonly notices: readonly SetupNotice[];
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
  const instructionPlan = planInstructions(context);
  blockers.push(...instructionPlan.blockers);
  const snippetPlan = planSetupSnippets(context, instructionPlan.operations);
  blockers.push(...snippetPlan.blockers);
  const manifest = desiredManifest(
    context.manifest,
    apps,
    context.appCatalog,
    instructionPlan.ownership,
    context.selections.snippets === undefined ? undefined : snippetPlan.manifestSnippets,
  );
  const baseline = context.selections.baseline;

  if (context.manifest.status === "read-only") {
    blockers.push({ path: context.manifest.path, reason: context.manifest.problem.message });
  } else if (
    context.manifest.status === "ready" ||
    baseline?.createManifest === true ||
    (apps !== undefined && apps.managed.length > 0) ||
    context.selections.instructions !== undefined ||
    context.selections.snippets !== undefined
  ) {
    operations.push(createAuraManifestWriteOperation(context.manifest, manifest));
  }

  const shared = context.model.sharedInstructions;
  if (shared.problem !== undefined) {
    blockers.push({
      path: shared.path,
      reason: `Aura could not safely read this path (${shared.problem}) and will not overwrite it.`,
    });
  }

  operations.push(
    ...withPlannedSharedContent(
      instructionPlan.operations,
      context.model.sharedInstructions.path,
      snippetPlan,
    ),
  );

  return Object.freeze({
    blockers: Object.freeze(blockers),
    manifest,
    notices: snippetPlan.notices,
    plan: Object.freeze({
      manualSteps: Object.freeze([...appManualSteps(context), ...instructionPlan.manualSteps]),
      operations: Object.freeze(operations),
      summary: "Set up Aura on this machine from your selections.",
    }),
  });
}

function desiredManifest(
  state: AuraManifestState,
  apps: SetupSelections["apps"],
  appCatalog: readonly AppCatalogEntry[],
  ownershipUpdates: ReadonlyMap<string, readonly string[]>,
  snippets: AuraManifest["snippets"] | undefined,
): AuraManifest {
  const base = state.status === "ready" ? state.value : createEmptyAuraManifest();
  const ownership = desiredOwnership(base, ownershipUpdates);
  const withApps =
    apps === undefined
      ? { ...base, ownership }
      : { ...base, apps: desiredApps(base, apps, appCatalog), ownership };
  return snippets === undefined ? withApps : { ...withApps, snippets };
}

function planSetupSnippets(
  context: SetupStepContext,
  instructionOperations: readonly FileOperation[],
): ReturnType<typeof planSnippets> {
  const sharedSource = plannedSharedContent(
    instructionOperations,
    context.model.sharedInstructions.path,
  );
  return planSnippets(context, sharedSource ?? context.model.sharedInstructions.content ?? "");
}

function plannedSharedContent(
  operations: readonly FileOperation[],
  path: string,
): string | undefined {
  for (const operation of operations) {
    if (operation.type === "write" && operation.path === path) {
      return operation.content;
    }
    if (
      operation.type === "archive" &&
      operation.path === path &&
      operation.replacement?.type === "write"
    ) {
      return operation.replacement.content;
    }
  }
  return undefined;
}

function withPlannedSharedContent(
  operations: readonly FileOperation[],
  path: string,
  snippetPlan: ReturnType<typeof planSnippets>,
): readonly FileOperation[] {
  if (!snippetPlan.updated) {
    return operations;
  }
  let replaced = false;
  const result = operations.map((operation): FileOperation => {
    if (operation.type === "write" && operation.path === path) {
      replaced = true;
      return { ...operation, content: snippetPlan.content };
    }
    if (
      operation.type === "archive" &&
      operation.path === path &&
      operation.replacement?.type === "write"
    ) {
      replaced = true;
      return {
        ...operation,
        replacement: { ...operation.replacement, content: snippetPlan.content },
      };
    }
    return operation;
  });
  return replaced
    ? result
    : [...result, { content: snippetPlan.content, mode: 0o600, path, type: "write" }];
}

function desiredOwnership(
  base: AuraManifest,
  updates: ReadonlyMap<string, readonly string[]>,
): AuraManifest["ownership"] {
  const next = new Map(Object.entries(base.ownership));
  for (const [id, files] of updates) {
    const previous = next.get(id);
    next.set(id, {
      files: [...new Set([...(previous?.files ?? []), ...files])].sort(),
      mcpServerNames: previous?.mcpServerNames ?? [],
    });
  }
  // As in `desiredApps`: assignment would route a `__proto__` adapter id through the inherited
  // setter and drop the entry, and only `plugin.id` is pattern-checked upstream.
  return Object.fromEntries(next);
}

function desiredApps(
  base: AuraManifest,
  apps: NonNullable<SetupSelections["apps"]>,
  appCatalog: readonly AppCatalogEntry[],
): AuraManifest["apps"] {
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
  return Object.fromEntries(next);
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
