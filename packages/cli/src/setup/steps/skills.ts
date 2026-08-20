import type { AuraManifestSkill } from "@tryaura/aura-sdk";

import { hasSkillsHome, initialSkillSelection, managedSkillApps } from "../skill-app-support.js";
import { skillIdentity } from "../skill-planner-paths.js";
import {
  SETUP_ABORTED,
  SETUP_BACK,
  type SetupStep,
  type SetupStepContext,
  type SetupStepUnoffered,
} from "../types.js";
import { runFormChain } from "../wizard-chain.js";
import { selectedValues } from "../wizard-types.js";
import { finalizeSkills, type FinalizedSkills } from "./skill-finalize.js";
import {
  selectionsByIdentity,
  skillStages,
  type SkillsChainState,
  type SkillStageInputs,
} from "./skill-stages.js";

/**
 * The skills step: a picker over every allowed source, then a review form per remote skill.
 *
 * The review is the security boundary for directory content — a remote skill is arbitrary prompt
 * content, so nothing from a directory is installed without its full SKILL.md having been on
 * screen. Every review defaults to Skip, which is what makes that boundary hold under `--yes` and
 * exhausted scripts: a non-interactive run can only re-apply skills the manifest already records.
 */
export const skillsStep: SetupStep = {
  addKind: "skill",
  gather: gatherSkills,
  id: "skills",
  prerequisites: [
    {
      // Standing in for the whole flow: when apps ran in this pass, the run that establishes the
      // manifest is already in progress. Standalone, a machine without a manifest routes through
      // full setup first — allowlist and drift decisions are manifest-relative.
      id: "apps",
      isSatisfied: (context) => context.manifest.status === "ready",
      title: "an Aura manifest",
    },
    {
      // Both entries name the apps step because running it is what establishes either one; gather
      // tests every candidate, so the pair stays split only to name what is actually missing.
      //
      // Full setup has just completed Apps, so this only gates the standalone shortcut. The full
      // flow is still allowed to show a disabled picker after the user deliberately selected none.
      // Recorded skills satisfy it on their own: losing support must not strand the uninstall path.
      id: "apps",
      isSatisfied: (context) =>
        context.manifest.status === "ready" &&
        (hasSkillsHome(managedSkillApps(context)) || context.manifest.value.skills.length > 0),
      title: "a managed application that supports Agent Skills",
    },
  ],
  telemetryCategory: "skills",
  title: "Skills",
};

async function gatherSkills(context: SetupStepContext, io: Parameters<SetupStep["gather"]>[1]) {
  const approval = await approvePrivateSources(context, io);
  if (approval === SETUP_ABORTED || approval === SETUP_BACK) {
    return approval;
  }
  return gatherApprovedSkills(context, io, approval);
}

/** Lists and reviews skills after this run's private connection boundary has been settled. */
async function gatherApprovedSkills(
  context: SetupStepContext,
  io: Parameters<SetupStep["gather"]>[1],
  approval: readonly string[],
) {
  const approvedPrivateSourceIds = new Set(approval);
  const pendingSources = context.skillCatalog.pendingSources(approvedPrivateSourceIds);
  const listing = await io.load(
    {
      items: pendingSources.map((source) => ({ id: source.id, label: source.name })),
      prompt: "Loading skill sources…",
    },
    (update) => context.skillCatalog.load(approvedPrivateSourceIds, update),
  );
  const manifestSkills = recordedSkills(context);
  emitNotes(context, io, listing, manifestSkills);
  if (isEmptyCatalog(listing, manifestSkills)) {
    return emptyCatalogOutcome(context);
  }

  const inputs: SkillStageInputs = {
    approvedPrivateSourceIds,
    availableSkills: context.model.availableSkills ?? [],
    catalog: context.skillCatalog,
    listing,
    managedApps: managedSkillApps(context),
    manifestSkills,
    presetSkills: context.preset?.skills ?? [],
  };
  const opening = openingSelection(context, inputs, manifestSkills);
  noteHeldBack(inputs, io, opening.heldBack);
  const result = await runFormChain(skillStages(inputs), opening.state, io, {
    entry: chainEntry(context),
    flow: context.flow,
  });
  if (result === SETUP_ABORTED || result === SETUP_BACK) {
    return result;
  }

  const skills = await finalizeSkills(result, inputs, manifestSkills);
  return completedSelections(context, approval, skills, manifestSkills, result.decisions);
}

/**
 * Says out loud that a changed Apps answer cleared picks the user had already made.
 *
 * Dropping them silently is the part that reads as a bug: the picker simply reopens with fewer
 * boxes ticked and nothing on screen connects that to the application the user just deselected.
 */
function noteHeldBack(
  inputs: SkillStageInputs,
  io: Parameters<SetupStep["gather"]>[1],
  heldBack: readonly string[],
): void {
  if (heldBack.length === 0) {
    return;
  }
  const offered = selectionsByIdentity(inputs);
  const names = heldBack.map((identity) => offered.get(identity)?.id ?? identity);
  io.note(
    `Cleared ${names.join(", ")}: no application selected in the Apps step supports Agent ` +
      "Skills. Select one that does to choose them again.",
  );
}

function recordedSkills(context: SetupStepContext): readonly AuraManifestSkill[] {
  return context.manifest.status === "ready" ? context.manifest.value.skills : [];
}

function emptyCatalogOutcome(context: SetupStepContext): SetupStepUnoffered | typeof SETUP_BACK {
  return context.enteredBackward === true
    ? SETUP_BACK
    : { selections: { ...context.selections }, unoffered: true };
}

function chainEntry(context: SetupStepContext): "end" | "start" {
  return context.enteredBackward === true ? "end" : "start";
}

function completedSelections(
  context: SetupStepContext,
  approval: readonly string[],
  skills: FinalizedSkills,
  manifestSkills: readonly AuraManifestSkill[],
  decisions: Readonly<Record<string, string>>,
) {
  const recorded = new Set(manifestSkills.map((skill) => skillIdentity(skill.source, skill.id)));
  const updates = Object.entries(decisions)
    .filter(([identity, decision]) => decision === "install" && recorded.has(identity))
    .map(([identity]) => identity);
  if (skills.selected.length === 0 && manifestSkills.length === 0) {
    // Nothing chosen and nothing recorded: drop the stale slice so an unsupported new install
    // cannot carry forward after the Apps answer changes. This run's private-source approvals are
    // the one thing worth keeping — re-asking for them is friction, not safety — and an empty
    // `selected` keeps the slice from forcing manifest creation. See `shouldWriteManifest`.
    const { skills: _staleSkills, ...selections } = context.selections;
    return approval.length === 0
      ? selections
      : {
          ...selections,
          skills: { approvedPrivateSourceIds: approval, selected: [] },
        };
  }
  const selection = updates.length === 0 ? skills : { ...skills, updates };
  return {
    ...context.selections,
    skills:
      approval.length === 0 ? selection : { ...selection, approvedPrivateSourceIds: approval },
  };
}

/** Explicitly authorizes credential-bearing requests; the safe non-interactive default is none. */
async function approvePrivateSources(
  context: SetupStepContext,
  io: Parameters<SetupStep["gather"]>[1],
): Promise<readonly string[] | typeof SETUP_ABORTED | typeof SETUP_BACK> {
  const sources = context.skillCatalog.privateSources;
  if (sources.length === 0) {
    return [];
  }
  const offered = new Set<string>(sources.map((source) => source.id));
  const initial = (context.selections.skills?.approvedPrivateSourceIds ?? []).filter((id) =>
    offered.has(id),
  );
  if (context.enteredBackward === true) {
    return initial;
  }

  const result = await io.ask([
    {
      id: "approved-private-sources",
      initial,
      kind: "multiselect",
      label: "Private sources",
      options: sources.map((source) => ({
        description: `${source.url} · sends ${source.tokenEnv} as a bearer token`,
        label: source.name,
        value: source.id,
      })),
      prompt: "Which private skill directories may Aura connect to during this run?",
    },
  ]);
  if (result === "aborted") {
    return SETUP_ABORTED;
  }
  if (result === "back") {
    return SETUP_BACK;
  }
  return selectedValues(result["approved-private-sources"]);
}

/** First-visit banners: catalog problems, then the empty-catalog note when there is nothing. */
function emitNotes(
  context: SetupStepContext,
  io: Parameters<SetupStep["gather"]>[1],
  listing: Awaited<ReturnType<SetupStepContext["skillCatalog"]["load"]>>,
  manifestSkills: readonly AuraManifestSkill[],
): void {
  if (context.revisited === true) {
    return;
  }
  for (const note of listing.notes) {
    io.note(note);
  }
  if (isEmptyCatalog(listing, manifestSkills)) {
    io.note("No skills are available from the installed plugins or directories.");
  }
}

function isEmptyCatalog(
  listing: Awaited<ReturnType<SetupStepContext["skillCatalog"]["load"]>>,
  manifestSkills: readonly AuraManifestSkill[],
): boolean {
  return (
    listing.entries.length === 0 &&
    listing.unavailableSources.length === 0 &&
    manifestSkills.length === 0
  );
}

/** The chain's opening state, plus whatever the current Apps answer forces it to leave out. */
function openingSelection(
  context: SetupStepContext,
  inputs: SkillStageInputs,
  manifestSkills: readonly AuraManifestSkill[],
): { readonly heldBack: readonly string[]; readonly state: SkillsChainState } {
  const recorded = new Set(manifestSkills.map((skill) => skillIdentity(skill.source, skill.id)));
  const previous =
    context.selections.skills?.selected.map((skill) => skillIdentity(skill.source, skill.id)) ??
    (context.manifest.status === "ready"
      ? [...recorded]
      : inputs.presetSkills.map((skill) => skillIdentity(skill.source, skill.id)));
  const opening = initialSkillSelection(previous, recorded, inputs.managedApps);
  return {
    heldBack: opening.heldBack,
    state: {
      decisions: Object.fromEntries(
        (context.selections.skills?.updates ?? []).map((identity) => [identity, "install"]),
      ),
      selected: opening.selected,
    },
  };
}
