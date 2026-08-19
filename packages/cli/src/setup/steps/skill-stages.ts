import type { AuraManifestSkill, ResolvedSkillPack } from "@tryaura/aura-sdk";

import { hasSkillsHome, type ManagedSkillApp } from "../skill-app-support.js";
import type { SkillCatalog, SkillCatalogListing, SkillResolution } from "../skills-catalog.js";
import { skillIdentity } from "../skill-planner-paths.js";
import type { SkillSelection } from "../types.js";
import type { ChainStage } from "../wizard-chain.js";
import { foldDecisions, selectedValues } from "../wizard-types.js";
import { pickerOptions, pickerPrompt } from "./skill-picker.js";
import { movedFrom, REVIEW_PREFIX, reviewQuestion } from "./skill-review.js";

/** Enough rows to browse quickly without turning the first picker frame into a catalog dump. */
const INITIAL_SKILL_ROWS = 10;

/** What the skills chain carries between its picker and review forms. */
export interface SkillsChainState {
  /** Review answers by identity: `"install"` or `"skip"`. */
  readonly decisions: Readonly<Record<string, string>>;
  /** Picker answer: selected identities in picker order. */
  readonly selected: readonly string[];
}

/** Everything the stages read but never change during one gather. */
export interface SkillStageInputs {
  readonly approvedPrivateSourceIds: ReadonlySet<string>;
  readonly availableSkills: readonly ResolvedSkillPack[];
  readonly catalog: SkillCatalog;
  readonly listing: SkillCatalogListing;
  readonly managedApps: readonly ManagedSkillApp[];
  readonly manifestSkills: readonly AuraManifestSkill[];
  readonly presetSkills: readonly SkillSelection[];
}

export function skillStages(inputs: SkillStageInputs): readonly ChainStage<SkillsChainState>[] {
  return [pickerStage(inputs), reviewStage(inputs)];
}

/** A remote identity's install needs a fetch, and therefore the review boundary. */
export function isRemoteIdentity(identity: string): boolean {
  return identity.startsWith("directory:") || identity.startsWith("driver:");
}

/** The typed selection behind each offered identity: catalog entries plus manifest rows. */
export function selectionsByIdentity(
  inputs: SkillStageInputs,
): ReadonlyMap<string, SkillSelection> {
  const selections = new Map<string, SkillSelection>();
  for (const entry of inputs.listing.entries) {
    selections.set(entry.identity, { id: entry.id, source: entry.sourceId });
  }
  for (const skill of inputs.manifestSkills) {
    const identity = skillIdentity(skill.source, skill.id);
    if (!selections.has(identity)) {
      selections.set(identity, { id: skill.id, source: skill.source });
    }
  }
  for (const skill of inputs.presetSkills) {
    const identity = skillIdentity(skill.source, skill.id);
    if (!selections.has(identity)) {
      selections.set(identity, skill);
    }
  }
  return selections;
}

export function manifestByIdentity(
  manifestSkills: readonly AuraManifestSkill[],
): ReadonlyMap<string, AuraManifestSkill> {
  return new Map(manifestSkills.map((skill) => [skillIdentity(skill.source, skill.id), skill]));
}

function pickerStage(inputs: SkillStageInputs): ChainStage<SkillsChainState> {
  const supportsSkills = hasSkillsHome(inputs.managedApps);
  const selectable = new Set(
    supportsSkills ? inputs.listing.entries.map((entry) => entry.identity) : [],
  );
  const previous = new Set(
    [...inputs.manifestSkills, ...inputs.presetSkills].map((skill) =>
      skillIdentity(skill.source, skill.id),
    ),
  );

  return {
    apply: (state, answers) => ({
      ...state,
      // As with snippets: an unavailable row carried over from the manifest stays eligible, so
      // clearing it is how a user drops a skill whose source is gone.
      selected: selectedValues(answers["skills"]).filter(
        (identity) => selectable.has(identity) || previous.has(identity),
      ),
    }),
    label: "Skills",
    questions: (state) => {
      const options = pickerOptions(inputs);
      if (options.length === 0) {
        return undefined;
      }
      return [
        {
          id: "skills",
          initial: state.selected,
          kind: "multiselect",
          label: "Skills",
          options,
          prompt: pickerPrompt(inputs),
          // Counted over every row the query reaches, not just the installable ones: search also
          // matches the preserved, blocked, and unavailable rows, and a smaller number here would
          // promise less than `/` delivers.
          ...(options.length > INITIAL_SKILL_ROWS
            ? {
                search: {
                  initialLimit: INITIAL_SKILL_ROWS,
                  placeholder: `Search all ${String(options.length)} skills`,
                },
              }
            : {}),
        },
      ];
    },
  };
}

function reviewStage(inputs: SkillStageInputs): ChainStage<SkillsChainState> {
  const recorded = manifestByIdentity(inputs.manifestSkills);
  const offered = selectionsByIdentity(inputs);
  const entries = new Map(inputs.listing.entries.map((entry) => [entry.identity, entry]));
  // Built once for the whole gather: `needsReview` runs on every selected identity for both the
  // progress test and the question list, so re-deriving these per call was quadratic by default.
  const bundled = bundledByIdentity(inputs.availableSkills);
  const reviewable = (identity: string): boolean => needsReview(identity, recorded, bundled);

  return {
    apply: (state, answers) => ({
      ...state,
      decisions: foldDecisions(state.decisions, answers, REVIEW_PREFIX, "skip"),
    }),
    compactLabel: "Review",
    isApplicable: (state) => state.selected.some(reviewable),
    label: "Review",
    questions: async (state) => {
      const remote = state.selected.filter(isRemoteIdentity);
      const resolution = await inputs.catalog.resolve(
        remote.flatMap((identity) => {
          const selection = offered.get(identity);
          return selection === undefined ? [] : [selection];
        }),
        inputs.approvedPrivateSourceIds,
      );
      const resolutionWithBundled: SkillResolution = {
        problems: resolution.problems,
        resolved: new Map([...resolution.resolved, ...bundled]),
      };
      const questions = state.selected
        .filter(reviewable)
        .flatMap((identity) =>
          reviewQuestion(
            identity,
            state.decisions,
            resolutionWithBundled,
            recorded,
            entries.get(identity),
            offered.get(identity),
          ),
        );
      return questions.length === 0 ? undefined : questions;
    },
  };
}

function bundledByIdentity(
  packs: readonly ResolvedSkillPack[],
): ReadonlyMap<string, ResolvedSkillPack> {
  return new Map(packs.map((pack) => [skillIdentity(pack.source.id, pack.id), pack]));
}

function needsReview(
  identity: string,
  recorded: ReadonlyMap<string, AuraManifestSkill>,
  bundled: ReadonlyMap<string, ResolvedSkillPack>,
): boolean {
  if (isRemoteIdentity(identity)) {
    return true;
  }
  const previous = recorded.get(identity);
  const available = bundled.get(identity);
  return previous !== undefined && available !== undefined && movedFrom(previous, available);
}
