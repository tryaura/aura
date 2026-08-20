import { resolve } from "node:path";

import type { ArchiveFileReplacement, FileOperation, Scope } from "@tryaura/aura-sdk";
import { SHARED_INSTRUCTIONS_TEMPLATE } from "@tryaura/content-official";

import { planLinks } from "./instruction-links.js";
import { requiredEntries, withMandatorySources } from "./instruction-mandatory.js";
import { composeConsolidatedInstructions, unmergedSources } from "./instruction-merge.js";
import {
  archiveRelativePath,
  duplicateClusters,
  instructionInventory,
  instructionTargetContent,
  instructionTargetSource,
} from "./instructions.js";
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
  // A scope Aura will not configure is dropped here rather than in each planner below: wiring every
  // app to a target the wizard just said it could not read safely — or that the user declined —
  // would contradict what the user was told, and leave a machine full of links to a file Aura never
  // wrote.
  const scopeSelections = [selections.global, selections.project].filter(
    (selection): selection is InstructionScopeSelection =>
      selection !== undefined && selection.action !== "blocked" && selection.action !== "skip",
  );

  // A scope can also decline itself: consolidating a selection that composes to nothing leaves no
  // target to link to, and only the survivors are what `planLinks` may wire. Spelled as a loop
  // because `planScope` plans as it answers; a `filter` would hide that behind a pure-looking read.
  const linked: InstructionScopeSelection[] = [];
  for (const selection of scopeSelections) {
    if (planScope(context, selection, inventory, clusters, state)) {
      linked.push(selection);
    }
  }

  const linkOperations = planLinks(context, linked, state.archived, ownership, state.manualSteps);
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

/** Plans one scope's target, returning whether it ended up with content apps may be linked to. */
function planScope(
  context: SetupStepContext,
  requested: InstructionScopeSelection,
  inventory: ReturnType<typeof instructionInventory>,
  clusters: ReturnType<typeof duplicateClusters>,
  state: InstructionPlanState,
): boolean {
  const required = requiredEntries(context, requested, inventory);
  const selection = withMandatorySources(requested, required);
  if (selection.action === "keep" && required.length > 0) {
    // "Keep" leaves every file where it is, which a symbolic link cannot honour: it stands in for
    // the whole entry. Merging those entries here first is what keeps their guidance loaded once
    // the originals are archived — the alternative, archiving alone, would quietly stop applying
    // instructions the user asked to keep.
    return planScope(
      context,
      { ...selection, action: "consolidate", selectedSources: required.map((entry) => entry.path) },
      inventory,
      clusters,
      state,
    );
  }
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
    // The starter template keeps none of what these entries held, but a symbolic link still cannot
    // stand at a path carrying the user's own text. Archiving is what makes the link wirable, and
    // it preserves the text rather than dropping it: the run names the backup, and `aura undo`
    // puts every one of them back.
    planOriginals(context, selection, required, new Set(), state);
    return true;
  }
  if (selection.action !== "consolidate") {
    return true;
  }

  const content = composeConsolidatedInstructions(
    chosen,
    selection,
    clusters,
    context.model,
    existing,
  );
  // Nothing selected, or nothing of it left to write. Declining this one scope is the whole of the
  // response wherever the tier survives being declined: a blocker would abort the run and write
  // nothing anywhere, including the other scope the user did configure.
  //
  // The global tier does not survive it. INS-001 and INS-002 fire at error severity against a
  // missing shared source, which is why the action menu withholds its opt-out there — and an empty
  // selection must not become the way around that, leaving a run that applies everything else and
  // then fails its own closing checklist.
  if (content.trim().length === 0) {
    if (selection.scope === "global") {
      state.blockers.push({
        path: selection.targetPath,
        reason:
          "No selected instruction content is available to consolidate. Select a source, or choose the starter template.",
      });
      return false;
    }
    state.manualSteps.push(
      `Configure ${selection.targetPath} on the next run: select at least one project source to consolidate, or choose the starter template. Aura wrote nothing there.`,
    );
    return false;
  }
  planConsolidatedTarget(context, selection, existing, content, state);
  planOriginals(
    context,
    selection,
    chosen,
    new Set(unmergedSources(chosen, selection, clusters, context.model, existing)),
    state,
  );
  return true;
}

function planConsolidatedTarget(
  context: SetupStepContext,
  selection: InstructionScopeSelection,
  existing: ReturnType<typeof instructionTargetSource>,
  content: string,
  state: InstructionPlanState,
): void {
  if (existing !== undefined) {
    // A merge that changed nothing is not a migration. Archiving anyway would back up and rewrite
    // identical bytes, so re-running the consolidate answer on a converged machine would add an
    // undo entry every time — the empty plan is the honest answer, and the one that converges.
    if (existing.content === content) {
      return;
    }
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
 * Archives the sources the merged text came from, and leaves behind the ones it did not.
 *
 * Consolidation is a migration, so a source that reached the target is backed up and taken off disk
 * in the same plan, before app links replace or remove what is left. A source the merge left out is
 * the one case where that would delete the only copy of what the file says: its heading is already
 * in the target, so nothing new was appended, and the text on disk is not text the target holds. It
 * stays where it is and the run names it. That step repeats until the divergence is resolved, which
 * is work someone does have to do — unlike a line per untouched file on a converged machine.
 */
function planOriginals(
  context: SetupStepContext,
  selection: InstructionScopeSelection,
  chosen: ReturnType<typeof instructionInventory>,
  unmerged: ReadonlySet<string>,
  state: InstructionPlanState,
): void {
  for (const source of chosen) {
    if (unmerged.has(resolve(source.path))) {
      state.manualSteps.push(
        `${source.path} changed since Aura merged it into ${selection.targetPath}, so Aura left the file in place rather than archiving text the target does not have. Move what is new into ${selection.targetPath}, then delete ${source.path}.`,
      );
      continue;
    }
    const relativePath = archiveRelativePath(source.path, source.scope, context.model);
    if (relativePath === undefined) {
      state.blockers.push({ path: source.path, reason: "The source has no safe archive path." });
    } else {
      state.archived.set(resolve(source.path), { relativePath, scope: source.scope });
    }
  }
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
