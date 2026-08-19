import type { SnippetCatalogEntry } from "../snippets.js";
import { SETUP_ABORTED, SETUP_BACK, type SetupStep, type SetupStepContext } from "../types.js";
import { runFormChain } from "../wizard-chain.js";
import {
  acceptedUpdates,
  snippetOptions,
  snippetStages,
  type SnippetsChainState,
  type SnippetStageInputs,
} from "./snippet-stages.js";

/**
 * The snippets step: a picker over every available snippet, then a review form per pending update.
 *
 * The two forms run as one chain so ← walks back from the review into the picker rather than out
 * of the step: leaving would discard both the boxes just ticked and every review already answered.
 * Every review defaults to keeping the installed version, which is what holds managed content at
 * its recorded revision under `--yes`.
 */
export const snippetsStep: SetupStep = {
  addKind: "snippet",
  gather: async (context, io) => {
    const catalog = await context.snippetCatalog.load();
    const inputs = stageInputs(context, catalog);
    if (context.revisited !== true) {
      emitUnavailableNotes(catalog, io.note);
    }
    if (snippetOptions(inputs).length === 0) {
      return emptyCatalogOutcome(context, io);
    }

    const result = await runFormChain(snippetStages(inputs), openingState(context, inputs), io, {
      entry: context.enteredBackward === true ? "end" : "start",
      flow: context.flow,
    });
    if (result === SETUP_ABORTED || result === SETUP_BACK) {
      return result;
    }
    return completedSelections(context, result);
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
  title: "Snippets",
};

function stageInputs(
  context: SetupStepContext,
  catalog: readonly SnippetCatalogEntry[],
): SnippetStageInputs {
  const previous = previousSnippetIds(context);
  const preset = new Set(context.preset?.snippets ?? []);
  return {
    catalog,
    context,
    preset,
    previous,
    // A fresh manifest opens on the preset's selections; an existing one is authoritative, so
    // deliberate adjustments are never reset to preset defaults on a later run.
    retained: context.manifest.status === "ready" ? previous : preset,
  };
}

/** The chain's opening state: this run's answers if it already has some, else the retained set. */
function openingState(context: SetupStepContext, inputs: SnippetStageInputs): SnippetsChainState {
  const selected =
    context.selections.snippets?.selected ??
    snippetOptions(inputs)
      .filter((option) => inputs.retained.has(option.value))
      .map((option) => option.value);
  return {
    decisions: Object.fromEntries(
      (context.selections.snippets?.updates ?? []).map((id) => [id, "update"]),
    ),
    selected,
  };
}

function completedSelections(context: SetupStepContext, state: SnippetsChainState) {
  const updates = acceptedUpdates(state);
  return {
    ...context.selections,
    snippets:
      updates.length === 0 ? { selected: state.selected } : { selected: state.selected, updates },
  };
}

function emptyCatalogOutcome(context: SetupStepContext, io: Parameters<SetupStep["gather"]>[1]) {
  if (context.enteredBackward === true) {
    return SETUP_BACK;
  }
  if (context.revisited !== true) {
    io.note("No snippets are available from the installed plugins.");
  }
  return { ...context.selections, snippets: { selected: [] } };
}

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
