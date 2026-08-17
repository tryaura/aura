import { notFoundLine } from "../../not-found-line.js";
import { safe } from "../../safe-text.js";
import { catalogEntryId, catalogEntryName, type AppCatalogEntry } from "../catalog.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStep, type SetupStepContext } from "../types.js";
import {
  selectedValues,
  type WizardIo,
  type WizardOption,
  type WizardQuestion,
} from "../wizard-types.js";

/**
 * The app-selection step: which agent applications should Aura manage.
 *
 * A preflight banner shows every registered adapter's status first, so "installed but unsupported"
 * is visible before the user commits. The multiselect then offers the whole catalog: detected and
 * previously-managed apps come pre-checked, and an app that is not installed stays selectable —
 * choosing it queues install instructions in the final summary instead of failing.
 */
export const appsStep: SetupStep = {
  gather: async (context, io) => {
    const catalog = context.appCatalog;
    if (catalog.length === 0) {
      return emptyCatalogOutcome(context, io);
    }

    const previouslyManaged = previouslyManagedIds(context);
    const detectedCount = detectedAppCount(catalog);
    if (context.revisited !== true) {
      emitBanner(catalog, detectedCount, io);
    }
    const question: WizardQuestion = {
      compactLabel: "Apps",
      id: "apps",
      initial: initialSelection(context, catalog, previouslyManaged),
      kind: "multiselect",
      label: "Applications",
      options: catalog.map((entry) => appOption(entry, previouslyManaged)),
      prompt: "Which applications should Aura manage?",
    };

    // Only a selection that drops something needs the explicit "nothing will be managed" stop.
    const mustConfirmEmpty = detectedCount > 0 || previouslyManaged.size > 0;
    const selected = await askForSelection(question, io, mustConfirmEmpty);
    if (selected === SETUP_ABORTED || selected === SETUP_BACK) {
      return selected;
    }
    return withApps(context, selected);
  },
  compactTitle: "Apps",
  id: "apps",
  title: "Applications",
};

/** With no adapters registered there is nothing to ask; ← keeps walking, → passes through. */
function emptyCatalogOutcome(
  context: SetupStepContext,
  io: WizardIo,
): SetupStepContext["selections"] | typeof SETUP_BACK {
  if (context.enteredBackward === true) {
    return SETUP_BACK;
  }
  if (context.revisited !== true) {
    io.note("No agent application adapters are registered.");
  }
  return context.selections;
}

/** A re-entered step shows the answer this run already gave it, not its cold-start proposal. */
function initialSelection(
  context: SetupStepContext,
  catalog: readonly AppCatalogEntry[],
  previouslyManaged: ReadonlySet<string>,
): readonly string[] {
  return (
    context.selections.apps?.managed ??
    catalog
      .filter((entry) => entry.kind === "detected" || previouslyManaged.has(catalogEntryId(entry)))
      .map(catalogEntryId)
  );
}

function detectedAppCount(catalog: readonly AppCatalogEntry[]): number {
  return catalog.filter((entry) => entry.kind === "detected").length;
}

/** One status line per adapter, then context for the zero-detection machine. */
function emitBanner(
  catalog: readonly AppCatalogEntry[],
  detectedCount: number,
  io: WizardIo,
): void {
  for (const entry of catalog) {
    io.note(statusLine(entry));
  }
  if (detectedCount === 0) {
    io.note(
      "No agent applications were detected. You can still select ones to install; install instructions appear in the final summary.",
    );
  }
}

async function askForSelection(
  question: WizardQuestion,
  io: WizardIo,
  mustConfirmEmpty: boolean,
): Promise<readonly string[] | typeof SETUP_ABORTED | typeof SETUP_BACK> {
  for (;;) {
    const result = await io.ask([question]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }

    const selected = selectedValues(result["apps"]);
    if (selected.length > 0 || !mustConfirmEmpty) {
      return selected;
    }

    const confirmation = await io.confirm(
      "No applications selected — nothing will be managed. Continue?",
    );
    if (confirmation === "accepted") {
      return selected;
    }
    if (confirmation === "aborted") {
      return SETUP_ABORTED;
    }
    // Declined: reopen the form so the selection can be revised.
  }
}

function withApps(
  context: SetupStepContext,
  managed: readonly string[],
): SetupStepContext["selections"] {
  return { ...context.selections, apps: { managed } };
}

function previouslyManagedIds(context: SetupStepContext): ReadonlySet<string> {
  if (context.manifest.status !== "ready") {
    return new Set();
  }
  return new Set(
    Object.entries(context.manifest.value.apps)
      .filter(([, app]) => app.managed)
      .map(([id]) => id),
  );
}

function statusLine(entry: AppCatalogEntry): string {
  if (entry.kind === "undetected") {
    return `✗ ${notFoundLine(entry.displayName, entry.detectionScope)}`;
  }

  const app = entry.app;
  const name = safe(app.displayName);
  const version = app.detection.version === undefined ? "" : ` ${safe(app.detection.version)}`;
  if (app.support.status === "unsupported") {
    return `⚠ ${name}${version} — unsupported version (supported: ${safe(app.support.supportedRange)}); fixes are downgraded`;
  }
  if (app.support.status === "unknown") {
    return `⚠ ${name} — version unknown (supported: ${safe(app.support.supportedRange)})`;
  }
  if (app.detection.authenticated === false) {
    return `⚠ ${name}${version} (not authenticated)`;
  }
  return `✓ ${name}${version}${app.detection.authenticated === true ? " (authenticated)" : ""}`;
}

function appOption(entry: AppCatalogEntry, previouslyManaged: ReadonlySet<string>): WizardOption {
  const managed = previouslyManaged.has(catalogEntryId(entry));
  const tags = [
    ...(managed ? [" (managed)"] : []),
    ...(entry.kind === "undetected" ? [" (not installed)"] : []),
  ].join("");
  const version =
    entry.kind === "detected" && entry.app.detection.version !== undefined
      ? ` ${safe(entry.app.detection.version)}`
      : "";

  return {
    description: appOptionDescription(entry, managed),
    label: `${safe(catalogEntryName(entry))}${version}${tags}`,
    value: catalogEntryId(entry),
  };
}

function appOptionDescription(entry: AppCatalogEntry, managed: boolean): string | undefined {
  if (entry.kind === "undetected") {
    return "Not installed — selecting it adds install instructions to the final summary.";
  }
  if (entry.app.support.status !== "supported") {
    return "Unsupported version — Aura downgrades its fixes to manual guidance.";
  }
  if (managed) {
    return "Currently managed — unchecking stops Aura from managing it.";
  }
  return undefined;
}
