import type { AuraManifestSnippet } from "@tryaura/aura-sdk";
import {
  diffManagedSnippet,
  hashManagedSnippet,
  managedContentRevisionStatus,
  readManagedBlock,
  type ManagedContentRevisionStatus,
} from "@tryaura/core";

import { sortForDisplay } from "../display-order.js";
import type { SnippetCatalogEntry } from "../snippets.js";
import type { SetupStepContext } from "../types.js";
import type { ChainStage } from "../wizard-chain.js";
import {
  foldDecisions,
  selectedValues,
  type WizardOption,
  type WizardQuestion,
} from "../wizard-types.js";

const REVIEW_PREFIX = "snippet-update:";

/** What the snippets chain carries between its picker and its update review. */
export interface SnippetsChainState {
  /** Review answers by snippet id: `"update"` or `"keep"`. */
  readonly decisions: Readonly<Record<string, string>>;
  /** Picker answer: selected snippet ids in picker order. */
  readonly selected: readonly string[];
}

/** Everything the stages read but never change during one gather. */
export interface SnippetStageInputs {
  readonly catalog: readonly SnippetCatalogEntry[];
  readonly context: SetupStepContext;
  /** Snippet ids the active team preset selects, labelled as such in the picker. */
  readonly preset: ReadonlySet<string>;
  /** Manifest snippet ids, which stay eligible even when their plugin is gone. */
  readonly previous: ReadonlySet<string>;
  /** What the picker opens with: recorded selections, or the preset on a fresh manifest. */
  readonly retained: ReadonlySet<string>;
}

export function snippetStages(
  inputs: SnippetStageInputs,
): readonly ChainStage<SnippetsChainState>[] {
  return [pickerStage(inputs), reviewStage(inputs)];
}

export function snippetOptions(inputs: SnippetStageInputs): readonly WizardOption[] {
  const { catalog, preset, previous } = inputs;
  return sortForDisplay(catalog, (entry) => [entry.category, entry.name, entry.id]).map((entry) =>
    entry.status === "available"
      ? {
          description: entry.description,
          group: entry.category,
          label: `${entry.name}${preset.has(entry.id) ? " (from preset)" : ""}`,
          preview: entry.content,
          value: entry.id,
        }
      : {
          description: previous.has(entry.id)
            ? `${entry.reason} Clear it to remove the snippet.`
            : `${entry.description} ${entry.reason}`,
          disabled: true,
          group: entry.category,
          label: `${previous.has(entry.id) ? `${entry.name} (preserved)` : entry.name}${preset.has(entry.id) ? " (from preset)" : ""}`,
          value: entry.id,
        },
  );
}

/** The ids whose review answer accepted the available revision. */
export function acceptedUpdates(state: SnippetsChainState): readonly string[] {
  return state.selected.filter((id) => state.decisions[id] === "update");
}

function pickerStage(inputs: SnippetStageInputs): ChainStage<SnippetsChainState> {
  const options = snippetOptions(inputs);
  const selectable = new Set(
    options.filter((option) => option.disabled !== true).map((option) => option.value),
  );

  return {
    // An unavailable row cannot be checked, but one carried over from a previous run stays
    // eligible so clearing it is how a user drops a snippet whose plugin is gone. Re-adding it
    // here instead would make that selection permanent.
    apply: (state, answers) => ({
      ...state,
      selected: selectedValues(answers["snippets"]).filter(
        (id) => selectable.has(id) || inputs.retained.has(id),
      ),
    }),
    label: "Snippets",
    questions: (state) =>
      options.length === 0
        ? undefined
        : [
            {
              id: "snippets",
              initial: state.selected,
              kind: "multiselect",
              label: "Snippets",
              options,
              prompt: "Which snippets should Aura add to the shared instructions?",
            },
          ],
  };
}

function reviewStage(inputs: SnippetStageInputs): ChainStage<SnippetsChainState> {
  const installed = installedById(inputs.context);
  const available = new Map(inputs.catalog.map((entry) => [entry.id, entry]));

  return {
    apply: (state, answers) => ({
      ...state,
      decisions: foldDecisions(state.decisions, answers, REVIEW_PREFIX, "keep"),
    }),
    compactLabel: "Review",
    label: "Review",
    questions: (state) => {
      const questions = state.selected.flatMap((id) =>
        reviewQuestion(id, state, inputs, installed.get(id), available.get(id)),
      );
      return questions.length === 0 ? undefined : questions;
    },
  };
}

/**
 * The one form asking about a snippet whose source revision no longer matches the recorded one.
 *
 * A diverged revision — a rollback, or one this build cannot order — is offered too, because the
 * alternative is holding the snippet at its recorded revision forever with nothing on screen. Both
 * default to keeping what is installed, which is what makes a non-interactive run safe.
 */
function reviewQuestion(
  id: string,
  state: SnippetsChainState,
  inputs: SnippetStageInputs,
  installed: AuraManifestSnippet | undefined,
  available: SnippetCatalogEntry | undefined,
): readonly WizardQuestion[] {
  if (installed === undefined || available?.status !== "available") {
    return [];
  }
  const status = managedContentRevisionStatus(
    installed.version,
    installed.hash,
    available.version,
    hashManagedSnippet(available.content),
  );
  if (status === "current") {
    return [];
  }
  const preview = updatePreview(inputs.context, installed, available.content);
  return [
    {
      id: `${REVIEW_PREFIX}${id}`,
      initial: [state.decisions[id] ?? "keep"],
      kind: "select",
      label: `Review ${id}`,
      options: [
        {
          description: `Keep installed version ${installed.version}.`,
          label: "Keep installed version",
          value: "keep",
        },
        {
          ...(preview === undefined
            ? { disabled: true, disabledNote: "resolve MGD-001 first" }
            : { preview }),
          description: `Review and install version ${available.version}.`,
          label: `${status === "update" ? "Update to" : "Switch to"} ${available.version}`,
          value: "update",
        },
      ],
      prompt: reviewPrompt(id, status, installed.version, available.version),
    },
  ];
}

function reviewPrompt(
  id: string,
  status: ManagedContentRevisionStatus,
  installedVersion: string,
  availableVersion: string,
): string {
  return status === "update"
    ? `A newer source revision is available for ${id}.`
    : `The installed plugin offers ${id} at version ${availableVersion}, which is not newer than ` +
        `the recorded version ${installedVersion}. Aura keeps the recorded revision unless you ` +
        "switch to it here.";
}

function installedById(context: SetupStepContext): ReadonlyMap<string, AuraManifestSnippet> {
  return new Map(
    context.manifest.status === "ready"
      ? context.manifest.value.snippets.map((snippet) => [snippet.id, snippet])
      : [],
  );
}

/** The diff shown on the update row, or nothing when local edits make it unsafe to offer. */
function updatePreview(
  context: SetupStepContext,
  installed: AuraManifestSnippet,
  availableContent: string,
): string | undefined {
  const document = context.model.sharedInstructions;
  if (document.content === undefined) {
    return undefined;
  }
  const parsed = readManagedBlock(document.content);
  if (parsed.status !== "present") {
    return undefined;
  }
  const snippet = parsed.block.snippets.find((candidate) => candidate.id === installed.id);
  if (snippet === undefined || !snippet.hashMatches || snippet.computedHash !== installed.hash) {
    return undefined;
  }
  return diffManagedSnippet(document.path, snippet.content, availableContent);
}
