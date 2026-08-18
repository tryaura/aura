import { resolve } from "node:path";

import type { ArchiveFileReplacement, FileOperation, Scope } from "@tryaura/aura-sdk";
import { planSharedInstructionLink } from "@tryaura/core";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";

import {
  archiveRelativePath,
  composeConsolidatedInstructions,
  duplicateClusters,
  instructionInventory,
  instructionTargetContent,
  instructionTargetSource,
} from "./instructions.js";
import { managedAppIdList } from "./managed-apps.js";
import type { SetupBlocker } from "./planner.js";
import type { InstructionScopeSelection, SetupStepContext } from "./types.js";

/**
 * Mode for an instruction file Aura composes.
 *
 * Owner-only, because consolidation merges whatever the sources held — including guidance a user
 * deliberately kept in a 0600 file — into one place, and the merge must not be the step that widens
 * access to it. `resolveWriteMode` preserves an existing file's mode, so this only settles what a
 * file Aura creates starts out as.
 */
const COMPOSED_INSTRUCTIONS_MODE = 0o600;

export interface InstructionPlan {
  readonly blockers: readonly SetupBlocker[];
  readonly manualSteps: readonly string[];
  readonly operations: readonly FileOperation[];
  readonly ownership: ReadonlyMap<string, readonly string[]>;
}

interface InstructionPlanState {
  readonly archived: Map<string, { readonly relativePath: string; readonly scope: Scope }>;
  readonly blockers: SetupBlocker[];
  readonly manualSteps: string[];
  readonly operations: FileOperation[];
}

export function planInstructions(context: SetupStepContext): InstructionPlan {
  const selections = context.selections.instructions;
  if (selections === undefined) {
    return { blockers: [], manualSteps: [], operations: [], ownership: new Map() };
  }

  const state: InstructionPlanState = {
    archived: new Map(),
    blockers: [],
    manualSteps: [],
    operations: [],
  };
  const ownership = new Map<string, string[]>();
  const inventory = instructionInventory(context.model);
  const clusters = duplicateClusters(context.findings ?? []);
  // A scope Aura refused to configure is dropped here rather than in each planner below: wiring
  // every app to a target the wizard just said it could not read safely would contradict the note
  // the user was given, and leave a machine full of links to a file Aura never wrote.
  const scopeSelections = [selections.global, selections.project].filter(
    (selection): selection is InstructionScopeSelection =>
      selection !== undefined && selection.action !== "blocked",
  );

  for (const selection of scopeSelections) {
    planScope(context, selection, inventory, clusters, state);
  }

  const linkOperations = planLinks(
    context,
    scopeSelections,
    state.archived,
    ownership,
    state.manualSteps,
  );
  for (const [path, archive] of state.archived) {
    const linkIndex = linkOperations.findIndex(
      (operation) => resolve(primaryPath(operation)) === path,
    );
    const link = linkIndex === -1 ? undefined : linkOperations.splice(linkIndex, 1)[0];
    state.operations.push({
      path,
      relativePath: archive.relativePath,
      ...(link === undefined ? {} : { replacement: replacementFor(link) }),
      type: "archive",
    });
  }
  state.operations.push(...linkOperations);
  return { ...state, ownership };
}

function planScope(
  context: SetupStepContext,
  selection: InstructionScopeSelection,
  inventory: ReturnType<typeof instructionInventory>,
  clusters: ReturnType<typeof duplicateClusters>,
  state: InstructionPlanState,
): void {
  const selected = new Set(selection.selectedSources.map((path) => resolve(path)));
  const chosen = inventory.filter(
    (source) => source.scope === selection.scope && selected.has(resolve(source.path)),
  );
  const existing = instructionTargetSource(context.model, selection.scope, selection.targetPath);

  if (selection.action === "template") {
    if (
      instructionTargetContent(context.model, selection.scope, selection.targetPath) !==
      SHARED_INSTRUCTIONS_TEMPLATE
    ) {
      state.operations.push({
        content: SHARED_INSTRUCTIONS_TEMPLATE,
        mode: COMPOSED_INSTRUCTIONS_MODE,
        path: selection.targetPath,
        type: "write",
      });
    }
    return;
  }
  if (selection.action !== "consolidate") {
    return;
  }

  const content = composeConsolidatedInstructions(
    chosen,
    selection,
    clusters,
    context.model,
    existing,
  );
  planConsolidatedTarget(context, selection, existing, content, state);
  planOriginals(context, selection, chosen, state);
}

function planConsolidatedTarget(
  context: SetupStepContext,
  selection: InstructionScopeSelection,
  existing: ReturnType<typeof instructionTargetSource>,
  content: string,
  state: InstructionPlanState,
): void {
  if (content.trim().length === 0) {
    state.blockers.push({
      path: selection.targetPath,
      reason: "No selected instruction content is available to consolidate.",
    });
  } else if (existing !== undefined && selection.archiveOriginals) {
    const relativePath = archiveRelativePath(existing.path, selection.scope, context.model);
    if (relativePath === undefined) {
      state.blockers.push({ path: existing.path, reason: "The target has no safe archive path." });
    } else {
      state.operations.push({
        path: existing.path,
        relativePath,
        replacement: { content, mode: COMPOSED_INSTRUCTIONS_MODE, type: "write" },
        type: "archive",
      });
    }
  } else if (
    instructionTargetContent(context.model, selection.scope, selection.targetPath) !== content
  ) {
    state.operations.push({
      content,
      mode: COMPOSED_INSTRUCTIONS_MODE,
      path: selection.targetPath,
      type: "write",
    });
  }
}

/**
 * Decides what happens to the files the merged text came from.
 *
 * A source left in place produces no manual step. Keeping originals is the default answer, so a
 * line per untouched file would appear on every run forever — including the converged one, where
 * "Steps to take yourself" would name work nobody has to do. What that choice actually leaves
 * behind is guidance living in two places, and INS-003 reports exactly that against what is on disk
 * once setup ends on green.
 */
function planOriginals(
  context: SetupStepContext,
  selection: InstructionScopeSelection,
  chosen: ReturnType<typeof instructionInventory>,
  state: InstructionPlanState,
): void {
  if (!selection.archiveOriginals) {
    return;
  }
  for (const source of chosen) {
    const relativePath = archiveRelativePath(source.path, source.scope, context.model);
    if (relativePath === undefined) {
      state.blockers.push({ path: source.path, reason: "The source has no safe archive path." });
    } else {
      state.archived.set(resolve(source.path), { relativePath, scope: source.scope });
    }
  }
}

function planLinks(
  context: SetupStepContext,
  scopeSelections: readonly InstructionScopeSelection[],
  archived: ReadonlyMap<string, { readonly relativePath: string; readonly scope: Scope }>,
  ownership: Map<string, string[]>,
  manualSteps: string[],
): FileOperation[] {
  const managedIds = new Set(managedAppIdList(context));
  const operations: FileOperation[] = [];
  for (const app of context.model.apps) {
    if (app.synthetic === true || !managedIds.has(app.adapterId)) {
      continue;
    }
    operations.push(
      ...planAppLinks(context, app, scopeSelections, archived, ownership, manualSteps),
    );
  }
  return operations;
}

function planAppLinks(
  context: SetupStepContext,
  app: SetupStepContext["model"]["apps"][number],
  scopeSelections: readonly InstructionScopeSelection[],
  archived: ReadonlyMap<string, { readonly relativePath: string; readonly scope: Scope }>,
  ownership: Map<string, string[]>,
  manualSteps: string[],
): FileOperation[] {
  return scopeSelections.flatMap((selection) => {
    const link = selection.scope === "global" ? app.sharedLink : app.projectSharedLink;
    if (link === undefined) {
      return [];
    }
    // Resolved on both sides: `archived` is keyed by canonical path, and a miss here would plan a
    // write against pre-archival content on a path an archive already claims — two operations on
    // one path, which the kernel rejects as a conflict rather than falling back to anything.
    const outcome = planSharedInstructionLink(app, context.model, {
      link,
      ...(archived.has(resolve(link.entryPath)) ? { sourceContent: "" } : {}),
      symlinkTarget: selection.targetPath,
    });
    if ("blocked" in outcome) {
      manualSteps.push(`Aura could not wire ${link.entryPath}: ${outcome.blocked}`);
      return [];
    }
    manualSteps.push(...(outcome.plan.manualSteps ?? []));
    const files = ownership.get(app.adapterId) ?? [];
    files.push(link.entryPath);
    ownership.set(app.adapterId, files);
    return [...outcome.plan.operations];
  });
}

function primaryPath(operation: FileOperation): string {
  return operation.type === "move" ? operation.sourcePath : operation.path;
}

function replacementFor(operation: FileOperation): ArchiveFileReplacement {
  if (operation.type === "write") {
    return {
      content: operation.content,
      ...(operation.mode === undefined ? {} : { mode: operation.mode }),
      type: "write",
    };
  }
  if (operation.type === "symlink") {
    return { target: operation.target, type: "symlink" };
  }
  throw new Error(`Unsupported archived link replacement: ${operation.type}`);
}
