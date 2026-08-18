import type { AuraManifestSkill, ResolvedSkillPack } from "@tryaura/aura-sdk";

import type { SkillResolution } from "../skills-catalog.js";
import type { SkillSelection } from "../types.js";
import {
  isRemoteIdentity,
  manifestByIdentity,
  selectionsByIdentity,
  type SkillsChainState,
  type SkillStageInputs,
} from "./skill-stages.js";

export interface FinalizedSkills {
  readonly resolved: readonly ResolvedSkillPack[];
  readonly selected: readonly SkillSelection[];
}

/**
 * Folds the chain's answers into the planner's inputs.
 *
 * A new remote skill survives only with an explicit "install" and a fetched pack. A
 * manifest-recorded one always stays selected; its pack rides along only when it matches the
 * manifest — repair — or its update was reviewed and accepted, so a Skip or a failed fetch leaves
 * the previous manifest entry exactly as it was.
 */
export async function finalizeSkills(
  state: SkillsChainState,
  inputs: SkillStageInputs,
  manifestSkills: readonly AuraManifestSkill[],
): Promise<FinalizedSkills> {
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

/** One remote identity's fate, appended to the buffers. See {@link finalizeSkills} for the rules. */
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
