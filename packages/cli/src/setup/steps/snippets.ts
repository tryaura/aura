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
 * lead the picker as a locked record block: Aura planted the text unmarked and cannot tell it from
 * the user's own guidance any more, so there is no byte the picker could take back and nothing an
 * untick would honestly mean. Holding them apart from the offered rows is what keeps the numbers
 * below counting only what a tick would change.
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
      prompt: snippetsPrompt(options),
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

/** Heading over the record block; the rows under it left their own categories to get there. */
const INSTALLED_GROUP = "Already installed";

/** The block's one shared line, carried by its last row so it reads as the section's footer. */
const RECORD_NOTE = "Aura keeps the record; the text stays where it is.";

/**
 * The record block first, then one numbered row per snippet Aura could still add.
 *
 * An installed row is locked whether or not its plugin is still around. Its text is already in the
 * file, unmarked and indistinguishable from the user's own guidance, so neither direction of the
 * checkbox has anything to do — the row is there to report the record, not to be answered with.
 * Gathering those rows under one heading is what lets the numbers below start at 1 and count only
 * what a tick would change, and it empties out any category whose every snippet is installed.
 */
function snippetOptions(
  catalog: readonly SnippetCatalogEntry[],
  installed: ReadonlySet<string>,
  preset: ReadonlySet<string>,
): readonly WizardOption[] {
  const sorted = sortForDisplay(catalog, (entry) => [entry.category, entry.name, entry.id]);
  return [
    ...recordBlock(sorted.filter((entry) => installed.has(entry.id))),
    ...sorted
      .filter((entry) => !installed.has(entry.id))
      .map((entry) => offeredOption(entry, preset)),
  ];
}

/**
 * The installed rows, with the shared note appended to the last of them.
 *
 * They carry no preview: the cursor never lands on a locked row, so `p` could not reach one, and
 * what it would have shown is the plugin's text today rather than the bytes that were appended —
 * the record note already points at where the installed text actually lives.
 */
function recordBlock(entries: readonly SnippetCatalogEntry[]): readonly WizardOption[] {
  return entries.map((entry, index) => ({
    group: INSTALLED_GROUP,
    label: entry.name,
    locked: true,
    // The heading no longer says where the row came from, and a snippet whose plugin is gone has
    // no category left to report.
    note: entry.status === "available" ? entry.category : "plugin unavailable",
    value: entry.id,
    ...(index === entries.length - 1 ? { description: RECORD_NOTE } : {}),
  }));
}

/** A row a tick would act on, or one disabled because no installed plugin publishes its text. */
function offeredOption(entry: SnippetCatalogEntry, preset: ReadonlySet<string>): WizardOption {
  const base = {
    group: entry.category,
    label: `${entry.name}${preset.has(entry.id) ? " (from preset)" : ""}`,
    value: entry.id,
    ...(entry.status === "available" ? { preview: entry.content } : {}),
  };
  return entry.status === "available"
    ? { ...base, description: entry.description }
    : {
        ...base,
        description: `${entry.description} ${entry.reason}`,
        disabled: true,
        disabledNote: "source unavailable",
      };
}

/**
 * Says so plainly when the catalog holds nothing left to add rather than asking for an answer.
 *
 * A locked row and a disabled one are both past asking about, so what makes this a question is a
 * row that is neither. "Already installed" and "no installed plugin provides it" are different
 * facts, though, and the wording names which one the screen is actually reporting.
 */
function snippetsPrompt(options: readonly WizardOption[]): string {
  if (options.some((option) => option.locked !== true && option.disabled !== true)) {
    return "Which snippets should Aura add to the shared instructions?";
  }
  return options.every((option) => option.locked === true)
    ? "Every snippet the installed plugins provide is already in your instructions."
    : "Nothing here can be added: every snippet is either installed already or unavailable.";
}

/**
 * What the picker opens with: every installed id, plus this run's answer or the preset.
 *
 * Installed rows are locked, so they are seeded on every visit — there is no earlier answer that
 * could have dropped one. Their `✔` comes from the lock rather than from this seeding, so what it
 * settles is the answer the form reports back, not the checkbox the picker draws. The preset adds
 * only what it can actually contribute: a disabled row opening ticked is an answer `--yes` has no
 * way to take back.
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
