import type { SnippetCatalogEntry } from "../snippets.js";
import { SETUP_ABORTED, type SetupStep, type SetupStepContext } from "../types.js";
import { selectedValues, type WizardOption } from "../wizard-types.js";

export const snippetsStep: SetupStep = {
  dependsOn: ["instructions"],
  gather: async (context, io) => {
    const catalog = await context.snippetCatalog.load();
    const previous = previousSnippetIds(context);
    const options = snippetOptions(catalog, previous);
    emitUnavailableNotes(catalog, io.note);
    if (options.length === 0) {
      io.note("No snippets are available from the installed plugins.");
      return { ...context.selections, snippets: { selected: [] } };
    }

    const result = await io.ask([
      {
        id: "snippets",
        initial: options
          .filter((option) => previous.has(option.value))
          .map((option) => option.value),
        kind: "multiselect",
        label: "Snippets",
        options,
        prompt: "Which snippets should Aura add to the shared instructions?",
      },
    ]);
    if (result === "aborted") {
      return SETUP_ABORTED;
    }
    const selected = selectedSnippetIds(options, previous, selectedValues(result["snippets"]));
    return {
      ...context.selections,
      snippets: { selected },
    };
  },
  id: "snippets",
  title: "Snippets",
};

function previousSnippetIds(context: SetupStepContext): ReadonlySet<string> {
  return new Set(
    context.manifest.status === "ready"
      ? context.manifest.value.snippets.map((snippet) => snippet.id)
      : [],
  );
}

function emitUnavailableNotes(
  catalog: readonly SnippetCatalogEntry[],
  note: (text: string) => void,
): void {
  for (const entry of catalog) {
    if (entry.status === "unavailable") {
      note(`Snippet ${entry.id} is unavailable: ${entry.reason}`);
    }
  }
}

/**
 * Keeps what the user answered, in the order they were offered.
 *
 * An unavailable row cannot be checked, but one carried over from a previous run stays eligible so
 * clearing it is how a user drops a snippet whose plugin is gone. Re-adding it here instead would
 * make that selection permanent.
 */
function selectedSnippetIds(
  options: readonly WizardOption[],
  previous: ReadonlySet<string>,
  answered: readonly string[],
): string[] {
  const selectable = new Set(
    options.filter((option) => option.disabled !== true).map((option) => option.value),
  );
  return answered.filter((id) => selectable.has(id) || previous.has(id));
}

function snippetOptions(
  catalog: readonly SnippetCatalogEntry[],
  previous: ReadonlySet<string>,
): readonly WizardOption[] {
  return sortForDisplay(catalog).map((entry) =>
    entry.status === "available"
      ? {
          description: entry.description,
          group: entry.category,
          label: entry.name,
          preview: entry.content,
          value: entry.id,
        }
      : {
          description: previous.has(entry.id)
            ? `${entry.reason} Clear it to remove the snippet.`
            : `${entry.description} ${entry.reason}`,
          disabled: true,
          group: entry.category,
          label: previous.has(entry.id) ? `${entry.name} (preserved)` : entry.name,
          value: entry.id,
        },
  );
}

/**
 * Groups the picker by category, since the renderer only heads a run of adjacent rows — registry
 * order interleaves two plugins sharing a category and repeats its heading.
 */
function sortForDisplay(catalog: readonly SnippetCatalogEntry[]): readonly SnippetCatalogEntry[] {
  return [...catalog].sort(
    (left, right) =>
      compare(left.category, right.category) ||
      compare(left.name, right.name) ||
      compare(left.id, right.id),
  );
}

function compare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
