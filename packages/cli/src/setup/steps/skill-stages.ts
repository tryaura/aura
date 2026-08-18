import type { AuraManifestSkill, ResolvedSkillPack } from "@tryaura/aura-sdk";

import { sortForDisplay } from "../display-order.js";
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

/** What the skills chain carries between its picker and review forms. */
export interface SkillsChainState {
  /** Review answers by identity: `"install"` or `"skip"`. */
  readonly decisions: Readonly<Record<string, string>>;
  /** Picker answer: selected identities in picker order. */
  readonly selected: readonly string[];
}

/** Everything the stages read but never change during one gather. */
export interface SkillStageInputs {
  readonly catalog: SkillCatalog;
  readonly listing: SkillCatalogListing;
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
  const selectable = new Set(inputs.listing.entries.map((entry) => entry.identity));
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
          prompt: "Which skills should Aura install to the shared skills directory?",
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

/**
 * The review form for one remote skill, or nothing when there is no decision to make.
 *
 * No question for a manifest-recorded skill whose fetched tree matches the manifest — nothing
 * changed — or whose fetch failed: the planner then keeps the previous entry untouched.
 */
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

function pickerOptions(inputs: SkillStageInputs): readonly WizardOption[] {
  const covered = new Set(inputs.listing.entries.map((entry) => entry.identity));
  const unavailableById = new Map(
    inputs.listing.unavailableSources.map((source) => [source.id, source]),
  );
  const policy = inputs.catalog.policy;

  const entryRows = sortForDisplay(inputs.listing.entries, (entry) => [
    entry.sourceName,
    entry.name,
    entry.id,
  ]).map((entry): WizardOption => ({
    description: `${entry.description} · v${entry.version}`,
    group: entry.sourceName,
    label: entry.name,
    ...(entry.preview === undefined ? {} : { preview: entry.preview }),
    value: entry.identity,
  }));

  const manifestRows = inputs.manifestSkills.flatMap((skill): readonly WizardOption[] => {
    const identity = skillIdentity(skill.source, skill.id);
    if (covered.has(identity)) {
      return [];
    }
    const unavailable = unavailableById.get(skill.source);
    if (policy.allowedSourceIds !== undefined && !policy.allowedSourceIds.has(skill.source)) {
      return [
        {
          description: `Not allowed by team preset "${policy.presetName}". Clear it to remove the skill.`,
          disabled: true,
          group: skill.source,
          label: `${skill.id} (blocked)`,
          value: identity,
        },
      ];
    }
    return [
      {
        description:
          unavailable === undefined
            ? "Previously installed, but its source is unavailable. Clear it to remove the skill."
            : `Its source is unavailable (${unavailable.hint}). Clear it to remove the skill.`,
        disabled: true,
        group: unavailable?.name ?? skill.source,
        label: `${skill.id} (preserved)`,
        value: identity,
      },
    ];
  });

  const sourceRows = inputs.listing.unavailableSources
    .filter((source) => inputs.manifestSkills.every((skill) => skill.source !== source.id))
    .map((source): WizardOption => ({
      description: `unavailable (${source.hint})`,
      disabled: true,
      group: source.name,
      label: source.name,
      value: `source:${source.id}`,
    }));

  return [...entryRows, ...manifestRows, ...sourceRows];
}
