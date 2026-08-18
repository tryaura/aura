import type { AuraManifestSkill, ResolvedSkillPack } from "@tryaura/aura-sdk";

import { hasSkillsHome, type ManagedSkillApp } from "../skill-app-support.js";
import type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillCatalogListing,
  SkillResolution,
} from "../skills-catalog.js";
import { skillIdentity } from "../skill-planner-paths.js";
import type { SkillSelection } from "../types.js";
import type { ChainStage } from "../wizard-chain.js";
import type { WizardOption, WizardQuestion } from "../wizard-types.js";
import { selectedValues } from "../wizard-types.js";
import { pickerOptions, pickerPrompt } from "./skill-picker.js";

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
  readonly catalog: SkillCatalog;
  readonly listing: SkillCatalogListing;
  readonly managedApps: readonly ManagedSkillApp[];
  readonly manifestSkills: readonly AuraManifestSkill[];
}

const REVIEW_PREFIX = "review:";

export function skillStages(inputs: SkillStageInputs): readonly ChainStage<SkillsChainState>[] {
  return [pickerStage(inputs), reviewStage(inputs)];
}

/** A remote identity's install needs a fetch, and therefore the review boundary. */
export function isRemoteIdentity(identity: string): boolean {
  return identity.startsWith("directory:");
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
    inputs.manifestSkills.map((skill) => skillIdentity(skill.source, skill.id)),
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
        },
      ];
    },
  };
}

function reviewStage(inputs: SkillStageInputs): ChainStage<SkillsChainState> {
  const recorded = manifestByIdentity(inputs.manifestSkills);
  const offered = selectionsByIdentity(inputs);
  const entries = new Map(inputs.listing.entries.map((entry) => [entry.identity, entry]));

  return {
    apply: (state, answers) => {
      const decisions = { ...state.decisions };
      for (const [id, answer] of Object.entries(answers)) {
        if (id.startsWith(REVIEW_PREFIX)) {
          decisions[id.slice(REVIEW_PREFIX.length)] = selectedValues(answer)[0] ?? "skip";
        }
      }
      return { ...state, decisions };
    },
    compactLabel: "Review",
    isApplicable: (state) => state.selected.some(isRemoteIdentity),
    label: "Review",
    questions: async (state) => {
      const remote = state.selected.filter(isRemoteIdentity);
      if (remote.length === 0) {
        return undefined;
      }
      const resolution = await inputs.catalog.resolve(
        remote.flatMap((identity) => {
          const selection = offered.get(identity);
          return selection === undefined ? [] : [selection];
        }),
        inputs.approvedPrivateSourceIds,
      );
      const questions = remote.flatMap((identity) =>
        reviewQuestion(
          identity,
          state,
          resolution,
          recorded,
          entries.get(identity),
          offered.get(identity),
        ),
      );
      return questions.length === 0 ? undefined : questions;
    },
  };
}

/** No review for an unchanged manifest skill or a failed fetch; both preserve the prior entry. */
function reviewQuestion(
  identity: string,
  state: SkillsChainState,
  resolution: SkillResolution,
  recorded: ReadonlyMap<string, AuraManifestSkill>,
  entry: SkillCatalogEntry | undefined,
  selection: SkillSelection | undefined,
): readonly WizardQuestion[] {
  const pack = resolution.resolved.get(identity);
  const previous = recorded.get(identity);
  if (previous !== undefined && (pack === undefined || pack.treeHash === previous.treeHash)) {
    return [];
  }

  const localId = entry?.id ?? selection?.id ?? identity;
  const update = previous !== undefined;
  return [
    {
      id: `${REVIEW_PREFIX}${identity}`,
      initial: [state.decisions[identity] ?? "skip"],
      kind: "select",
      label: `Review ${localId}`,
      options: [
        skipOption(update),
        installOption(localId, update, pack, entry, resolution.problems.get(identity)),
      ],
      prompt: reviewPrompt(localId, update, pack, entry),
    },
  ];
}

function skipOption(update: boolean): WizardOption {
  return {
    description: update
      ? "Keep the installed version and its manifest entry."
      : "Leave this skill out of the plan.",
    label: update ? "Skip — keep the installed version" : "Skip — do not install",
    value: "skip",
  };
}

function reviewPrompt(
  localId: string,
  update: boolean,
  pack: ResolvedSkillPack | undefined,
  entry: SkillCatalogEntry | undefined,
): string {
  const sourceName = entry?.sourceName ?? "its directory";
  if (pack === undefined) {
    return `"${localId}" could not be fetched from ${sourceName}.`;
  }
  return (
    `${update ? "Update" : "Install"} "${pack.name}" ${pack.version} from ${sourceName}? ` +
    "Press p on the install row to read its full SKILL.md before deciding."
  );
}

function installOption(
  localId: string,
  update: boolean,
  pack: ResolvedSkillPack | undefined,
  entry: SkillCatalogEntry | undefined,
  problem: string | undefined,
): WizardOption {
  if (pack === undefined) {
    return {
      description: problem ?? "This skill could not be fetched.",
      disabled: true,
      label: `Install ${localId}`,
      value: "install",
    };
  }
  return {
    description: entry?.sourceUrl ?? entry?.sourceName ?? "",
    label: `${update ? "Update to" : "Install"} ${localId} ${pack.version}`,
    preview: pack.files.find((file) => file.path === "SKILL.md")?.content,
    value: "install",
  };
}
