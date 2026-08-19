import type { AuraManifestSnippet } from "@tryaura/aura-sdk";
import {
  hashManagedSnippet,
  managedContentRevisionStatus,
  readManagedBlock,
  reconcileParsedManagedBlock,
  type ManagedBlockNote,
  type ManagedBlockReadResult,
  type ManagedBlockWriteResult,
  type ManagedContentRevisionStatus,
} from "@tryaura/core";

import type { SetupBlocker, SetupNotice } from "./planner.js";
import type { SnippetCatalogEntry } from "./snippets.js";
import type { SetupStepContext } from "./types.js";

export interface SnippetPlan {
  readonly blockers: readonly SetupBlocker[];
  readonly content: string;
  readonly manifestSnippets: readonly AuraManifestSnippet[];
  readonly notices: readonly SetupNotice[];
  readonly updated: boolean;
}

/** Reconcile notes the user has to see, and the heading each one belongs under. */
const NOTICE_KINDS: Readonly<Partial<Record<ManagedBlockNote["code"], SetupNotice["kind"]>>> =
  Object.freeze({
    "overwritten-snippet": "overwritten",
    "preserved-unowned-snippet": "preserved",
  });

export function planSnippets(context: SetupStepContext, source: string): SnippetPlan {
  const selection = context.selections.snippets;
  const previous = context.manifest.status === "ready" ? context.manifest.value.snippets : [];
  if (selection === undefined) {
    return {
      blockers: [],
      content: source,
      manifestSnippets: previous,
      notices: [],
      updated: false,
    };
  }

  const catalog = new Map(context.snippetCatalog.entries().map((entry) => [entry.id, entry]));
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  const selectedEntries = selection.selected.flatMap((id) => {
    const entry = catalog.get(id);
    return entry === undefined ? [] : [entry];
  });
  const unavailable = selectedEntries.filter((entry) => entry.status === "unavailable");
  const pinned = selection.selected.filter((id) => previousById.get(id)?.pinned === true);
  const held = heldRevisions(selection.selected, catalog, previousById, new Set(selection.updates));
  const heldIds = new Set(held.map((entry) => entry.id));
  const pinnedIds = new Set(pinned);
  const preserved = [...unavailable.map((entry) => entry.id), ...pinned, ...heldIds];
  const parsed = readManagedBlock(source);
  const blockers = snippetBlockers(
    context.model.sharedInstructions.path,
    parsed,
    unavailable,
    pinned.filter((id) => !unavailable.some((entry) => entry.id === id)),
  );

  const desired = selectedEntries.flatMap((entry) =>
    entry.status === "available" && !pinnedIds.has(entry.id) && !heldIds.has(entry.id)
      ? [{ content: entry.content, id: entry.id }]
      : [],
  );
  const reconciled = reconcileParsedManagedBlock(source, parsed, desired, {
    ownedSnippetIds: previous.map((entry) => entry.id),
    preserveSnippetIds: preserved,
    previousSnippetHashes: new Map(previous.map((entry) => [entry.id, entry.hash])),
  });
  collectReconcileBlockers(context.model.sharedInstructions.path, parsed, reconciled, blockers);
  const manifestSnippets = desiredManifestSnippets(
    selection.selected,
    catalog,
    previousById,
    heldIds,
  );
  const notices = [
    ...reconciled.notes.flatMap((note): readonly SetupNotice[] => {
      const kind = NOTICE_KINDS[note.code];
      return kind === undefined ? [] : [{ kind, message: note.message }];
    }),
    ...held.map(heldNotice),
  ];

  return {
    blockers,
    content: reconciled.content,
    manifestSnippets,
    notices,
    updated: reconciled.status === "updated",
  };
}

/** One selected snippet whose source revision this run is not applying. */
interface HeldRevision {
  readonly availableVersion: string;
  readonly id: string;
  readonly installedVersion: string;
  readonly status: Exclude<ManagedContentRevisionStatus, "current">;
}

/**
 * The selections whose source moved but whose recorded revision this run keeps.
 *
 * Uses the same comparison the review form asks with, so "the step never offered it" and "the plan
 * never applied it" cannot drift apart: any revision the user was not asked about is held, and any
 * revision held is one the user was asked about and declined.
 */
function heldRevisions(
  selectedIds: readonly string[],
  catalog: ReadonlyMap<string, SnippetCatalogEntry>,
  previousById: ReadonlyMap<string, AuraManifestSnippet>,
  accepted: ReadonlySet<string>,
): readonly HeldRevision[] {
  return selectedIds.flatMap((id): readonly HeldRevision[] => {
    const installed = previousById.get(id);
    const available = catalog.get(id);
    if (
      installed === undefined ||
      installed.pinned === true ||
      available?.status !== "available" ||
      accepted.has(id)
    ) {
      return [];
    }
    const status = managedContentRevisionStatus(
      installed.version,
      installed.hash,
      available.version,
      hashManagedSnippet(available.content),
    );
    return status === "current"
      ? []
      : [
          {
            availableVersion: available.version,
            id,
            installedVersion: installed.version,
            status,
          },
        ];
  });
}

/**
 * Says out loud that a snippet was left at its recorded revision.
 *
 * Holding content back is the safe default, but a run that holds silently is indistinguishable
 * from one that had nothing to do — which is exactly the reading a `--yes` run would get wrong.
 */
function heldNotice(held: HeldRevision): SetupNotice {
  return {
    kind: "held",
    message:
      held.status === "update"
        ? `${held.id} stays at ${held.installedVersion}; ${held.availableVersion} is available. ` +
          "Run setup interactively to review it."
        : `${held.id} stays at ${held.installedVersion}; the installed plugin offers ` +
          `${held.availableVersion}, which is not newer.`,
  };
}

function snippetBlockers(
  path: string,
  parsed: ManagedBlockReadResult,
  unavailable: readonly { readonly id: string }[],
  pinned: readonly string[],
): SetupBlocker[] {
  const blockers: SetupBlocker[] = [];
  if (parsed.status === "invalid") {
    blockers.push({ path, reason: parsed.problems.map((problem) => problem.message).join(" ") });
  } else if (parsed.notes.some((note) => note.code === "unmanaged-content")) {
    blockers.push({
      path,
      reason:
        "The Aura managed block contains untagged content. Resolve the MGD-001 finding before changing snippets.",
    });
  }

  const existingIds =
    parsed.status === "present"
      ? new Set(parsed.block.snippets.map((snippet) => snippet.id))
      : new Set<string>();
  for (const entry of unavailable) {
    if (!existingIds.has(entry.id)) {
      blockers.push({
        path,
        reason: `Previously selected snippet "${entry.id}" is unavailable and its managed section is missing. Reinstall the plugin that provides it, or clear it in the snippets step to drop it.`,
      });
    }
  }
  for (const id of pinned) {
    if (!existingIds.has(id)) {
      blockers.push({
        path,
        reason: `Pinned snippet "${id}" is missing from the managed block. Restore the section or clear it in the snippets step to drop it.`,
      });
    }
  }
  return blockers;
}

function collectReconcileBlockers(
  path: string,
  parsed: ManagedBlockReadResult,
  reconciled: ManagedBlockWriteResult,
  blockers: SetupBlocker[],
): void {
  if (reconciled.status === "invalid" && parsed.status !== "invalid") {
    blockers.push({
      path,
      reason: reconciled.problems.map((problem) => problem.message).join(" "),
    });
  }
}

function desiredManifestSnippets(
  selectedIds: readonly string[],
  catalog: ReadonlyMap<string, SnippetCatalogEntry>,
  previousById: ReadonlyMap<string, AuraManifestSnippet>,
  heldUpdates: ReadonlySet<string>,
): readonly AuraManifestSnippet[] {
  return selectedIds.flatMap((id): readonly AuraManifestSnippet[] => {
    const preserved = previousById.get(id);
    if (preserved?.pinned === true) {
      return [preserved];
    }
    if (heldUpdates.has(id) && preserved !== undefined) {
      return [preserved];
    }
    const entry = catalog.get(id);
    if (entry?.status === "available") {
      return [
        { hash: hashManagedSnippet(entry.content), id, pinned: false, version: entry.version },
      ];
    }
    return preserved === undefined ? [] : [preserved];
  });
}
