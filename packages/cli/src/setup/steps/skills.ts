import type { AuraManifestSkill, ResolvedSkillPack } from "@tryaura/aura-sdk";

import { skillIdentity } from "../skill-planner-paths.js";
import type { SkillResolution } from "../skills-catalog.js";
import {
  SETUP_ABORTED,
  SETUP_BACK,
  type SetupStep,
  type SetupStepContext,
  type SkillSelection,
} from "../types.js";
import { runFormChain } from "../wizard-chain.js";
import { selectedValues } from "../wizard-types.js";
import {
  isRemoteIdentity,
  manifestByIdentity,
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
  ],
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
  const listing = await context.skillCatalog.load(approvedPrivateSourceIds);
  const manifestSkills = recordedSkills(context);
  emitNotes(context, io, listing, manifestSkills);
  if (isEmptyCatalog(listing, manifestSkills)) {
    return emptyCatalogOutcome(context);
  }

  const inputs: SkillStageInputs = {
    approvedPrivateSourceIds,
    catalog: context.skillCatalog,
    listing,
    manifestSkills,
  };
  const result = await runFormChain(
    skillStages(inputs),
    initialState(context, manifestSkills),
    io,
    {
      entry: chainEntry(context),
      flow: context.flow,
    },
  );
  if (result === SETUP_ABORTED || result === SETUP_BACK) {
    return result;
  }

  const skills = await finalize(result, inputs, manifestSkills);
  return completedSelections(context, approval, skills, manifestSkills);
}

function recordedSkills(context: SetupStepContext): readonly AuraManifestSkill[] {
  return context.manifest.status === "ready" ? context.manifest.value.skills : [];
}

function emptyCatalogOutcome(context: SetupStepContext) {
  return context.enteredBackward === true ? SETUP_BACK : { ...context.selections };
}

function chainEntry(context: SetupStepContext): "end" | "start" {
  return context.enteredBackward === true ? "end" : "start";
}

function completedSelections(
  context: SetupStepContext,
  approval: readonly string[],
  skills: Awaited<ReturnType<typeof finalize>>,
  manifestSkills: readonly AuraManifestSkill[],
) {
  if (skills.selected.length === 0 && manifestSkills.length === 0) {
    // Nothing chosen and nothing recorded: leave the slice absent so an otherwise-empty run
    // does not force manifest creation.
    return { ...context.selections };
  }
  return {
    ...context.selections,
    skills: approval.length === 0 ? skills : { ...skills, approvedPrivateSourceIds: approval },
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

function initialState(
  context: SetupStepContext,
  manifestSkills: readonly AuraManifestSkill[],
): SkillsChainState {
  const selected =
    context.selections.skills?.selected.map((skill) => skillIdentity(skill.source, skill.id)) ??
    manifestSkills.map((skill) => skillIdentity(skill.source, skill.id));
  return { decisions: {}, selected };
}

/**
 * Folds the chain's answers into the planner's inputs.
 *
 * A new remote skill survives only with an explicit "install" and a fetched pack. A
 * manifest-recorded one always stays selected; its pack rides along only when it matches the
 * manifest — repair — or its update was reviewed and accepted, so a Skip or a failed fetch leaves
 * the previous manifest entry exactly as it was.
 */
async function finalize(
  state: SkillsChainState,
  inputs: SkillStageInputs,
  manifestSkills: readonly AuraManifestSkill[],
): Promise<{
  readonly resolved: readonly ResolvedSkillPack[];
  readonly selected: readonly SkillSelection[];
}> {
  const offered = selectionsByIdentity(inputs);
  const recorded = manifestByIdentity(manifestSkills);
  const remote = state.selected.filter(isRemoteIdentity);
  const resolution: SkillResolution =
    remote.length === 0
      ? { problems: new Map(), resolved: new Map() }
      : await inputs.catalog.resolve(
          remote.flatMap((identity) => {
            const selection = offered.get(identity);
            return selection === undefined ? [] : [selection];
          }),
          inputs.approvedPrivateSourceIds,
        );

  const selected: SkillSelection[] = [];
  const resolved: ResolvedSkillPack[] = [];
  for (const identity of state.selected) {
    const selection = offered.get(identity);
    if (selection === undefined) {
      continue;
    }
    if (!isRemoteIdentity(identity)) {
      selected.push(selection);
      continue;
    }
    finalizeRemote(
      identity,
      selection,
      state,
      resolution.resolved.get(identity),
      recorded.get(identity),
      { resolved, selected },
    );
  }
  return { resolved, selected };
}

/** One remote identity's fate, appended to the buffers. See {@link finalize} for the rules. */
function finalizeRemote(
  identity: string,
  selection: SkillSelection,
  state: SkillsChainState,
  pack: ResolvedSkillPack | undefined,
  previous: AuraManifestSkill | undefined,
  buffers: { readonly resolved: ResolvedSkillPack[]; readonly selected: SkillSelection[] },
): void {
  if (previous === undefined) {
    if (state.decisions[identity] === "install" && pack !== undefined) {
      buffers.selected.push(selection);
      buffers.resolved.push(pack);
    }
    return;
  }
  buffers.selected.push(selection);
  if (pack === undefined) {
    return;
  }
  if (pack.treeHash === previous.treeHash || state.decisions[identity] === "install") {
    buffers.resolved.push(pack);
  }
}
