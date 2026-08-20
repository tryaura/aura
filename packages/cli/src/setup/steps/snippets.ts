import { sortForDisplay } from "../display-order.js";
import { installedSnippetNotes } from "../snippet-audit.js";
import type { SnippetCatalogEntry } from "../snippets.js";
import {
  SETUP_ABORTED,
  SETUP_BACK,
  type SetupStep,
  type SetupStepContext,
  type SetupStepUnoffered,
} from "../types.js";
import { selectedValues, type WizardOption, type WizardQuestion } from "../wizard-types.js";

/**
 * The snippets step: one picker over every snippet the installed plugins register.
 *
 * Ticking an unticked row appends its Markdown to the shared instructions once. Installed rows
 * open ticked and locked: Aura planted the text unmarked and cannot tell it from the user's own
 * guidance any more, so there is no byte the picker could take back and nothing an untick would
 * honestly mean.
 */
export const snippetsStep: SetupStep = {
  addKind: "snippet",
  gather: async (context, io) => {
    const catalog = await context.snippetCatalog.load();
    const installed = installedSnippetIds(context);
    if (context.revisited !== true) {
      emitCatalogNotes(context, catalog, installed, io.note);
    }
    if (catalog.length === 0) {
      return emptyCatalogOutcome(context, io);
    }

    const options = snippetOptions(catalog, installed, new Set(context.preset?.snippets ?? []));
    const selectable = new Set(
      options.filter((option) => option.disabled !== true).map((option) => option.value),
    );
    const question: WizardQuestion = {
      id: "snippets",
      initial: initialSelection(context, options, installed),
      kind: "multiselect",
      label: "Snippets",
      options,
      prompt: "Which snippets should Aura add to the shared instructions?",
    };
    const result = await io.ask([question], context.flow);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    if (result === "back") {
      return SETUP_BACK;
    }

    // A disabled row can still arrive here from a preset's opening tick, and the planner would
    // have nothing to append for it; the notice it earns is the planner's, not a selection.
    // Installed ids drop out either way — a locked row cannot have been answered with.
    const ticked = new Set(selectedValues(result["snippets"]));
    return {
      ...context.selections,
      snippets: {
        selected: [...ticked].filter((id) => !installed.has(id) && selectable.has(id)),
      },
    };
  },
  id: "snippets",
  prerequisites: [
    {
      id: "instructions",
      isSatisfied: (context) =>
        context.model.sharedInstructions.exists &&
        context.model.sharedInstructions.problem === undefined,
      title: "a readable shared instruction file",
    },
  ],
  telemetryCategory: "snippets",
  title: "Snippets",
};

/**
 * One row per snippet, disabled only where there is nothing Aura could do with a tick.
 *
 * An installed row is locked whether or not its plugin is still around. Its text is already in the
 * file, unmarked and indistinguishable from the user's own guidance, so neither direction of the
 * checkbox has anything to do — the row is there to report the record, not to be answered with.
 */
function snippetOptions(
  catalog: readonly SnippetCatalogEntry[],
  installed: ReadonlySet<string>,
  preset: ReadonlySet<string>,
): readonly WizardOption[] {
  return sortForDisplay(catalog, (entry) => [entry.category, entry.name, entry.id]).map((entry) => {
    const alreadyInstalled = installed.has(entry.id);
    const suffix = alreadyInstalled ? " (installed)" : preset.has(entry.id) ? " (from preset)" : "";
    const base = {
      group: entry.category,
      label: `${entry.name}${suffix}`,
      value: entry.id,
      ...(entry.status === "available" ? { preview: entry.content } : {}),
    };
    const description =
      entry.status === "available" ? entry.description : `${entry.description} ${entry.reason}`;
    if (alreadyInstalled) {
      return {
        ...base,
        description: `${description} Aura keeps the record; the text stays where it is.`,
        locked: true,
      };
    }
    return entry.status === "available"
      ? { ...base, description }
      : { ...base, description, disabled: true, disabledNote: "source unavailable" };
  });
}

/**
 * What the picker opens with: every installed id, plus this run's answer or the preset.
 *
 * Installed rows are locked, so they open ticked on every visit — there is no earlier answer that
 * could have dropped one. The preset adds only what it can actually contribute: a disabled row
 * opening ticked is an answer `--yes` has no way to take back.
 */
function initialSelection(
  context: SetupStepContext,
  options: readonly WizardOption[],
  installed: ReadonlySet<string>,
): readonly string[] {
  const preset = new Set(context.preset?.snippets ?? []);
  const chosen = context.selections.snippets;
  const kept = [...installed];
  const added =
    chosen?.selected ??
    options
      .filter(
        (option) =>
          option.disabled !== true && !installed.has(option.value) && preset.has(option.value),
      )
      .map((option) => option.value);
  return [...kept, ...added];
}

function emptyCatalogOutcome(
  context: SetupStepContext,
  io: Parameters<SetupStep["gather"]>[1],
): SetupStepUnoffered | typeof SETUP_BACK {
  if (context.enteredBackward === true) {
    return SETUP_BACK;
  }
  if (context.revisited !== true) {
    io.note("No snippets are available from the installed plugins.");
  }
  return { selections: { ...context.selections, snippets: { selected: [] } }, unoffered: true };
}

function installedSnippetIds(context: SetupStepContext): ReadonlySet<string> {
  return new Set(
    context.manifest.status === "ready"
      ? context.manifest.value.snippets.map((entry) => entry.id)
      : [],
  );
}

function emitCatalogNotes(
  context: SetupStepContext,
  catalog: readonly SnippetCatalogEntry[],
  installed: ReadonlySet<string>,
  note: (text: string) => void,
): void {
  for (const entry of catalog) {
    if (entry.status === "unavailable" && !installed.has(entry.id)) {
      note(`Snippet ${entry.id} is unavailable: ${entry.reason}`);
    }
  }
  const shared = context.model.sharedInstructions;
  const records = context.manifest.status === "ready" ? context.manifest.value.snippets : [];
  for (const text of installedSnippetNotes(records, catalog, shared.path, shared.content ?? "")) {
    note(text);
  }
}
