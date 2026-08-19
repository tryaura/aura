import type { AuraManifestSkill, ResolvedSkillPack } from "@tryaura/aura-sdk";
import { managedContentRevisionStatus } from "@tryaura/core";

import type { SkillCatalogEntry, SkillResolution } from "../skills-catalog.js";
import type { SkillSelection } from "../types.js";
import type { WizardOption, WizardQuestion } from "../wizard-types.js";

export const REVIEW_PREFIX = "review:";

/**
 * Whether the source revision differs from the recorded one at all.
 *
 * A diverged revision — a rollback, or a pair this build cannot order — is reviewable for the same
 * reason an upgrade is: the planner holds the recorded revision either way, so a revision that is
 * never offered here is one the user can never resolve, and it would sit held with nothing on
 * screen naming it.
 */
export function movedFrom(previous: AuraManifestSkill, available: ResolvedSkillPack): boolean {
  return (
    managedContentRevisionStatus(
      previous.version,
      previous.treeHash,
      available.version,
      available.treeHash,
    ) !== "current"
  );
}

/** No review for an unchanged manifest skill or a failed fetch; both preserve the prior entry. */
export function reviewQuestion(
  identity: string,
  decisions: Readonly<Record<string, string>>,
  resolution: SkillResolution,
  recorded: ReadonlyMap<string, AuraManifestSkill>,
  entry: SkillCatalogEntry | undefined,
  selection: SkillSelection | undefined,
): readonly WizardQuestion[] {
  const pack = resolution.resolved.get(identity);
  const previous = recorded.get(identity);
  if (previous !== undefined && (pack === undefined || !movedFrom(previous, pack))) {
    return [];
  }

  const localId = entry?.id ?? selection?.id ?? identity;
  const change = revisionChange(previous, pack);
  return [
    {
      id: `${REVIEW_PREFIX}${identity}`,
      initial: [decisions[identity] ?? "skip"],
      kind: "select",
      label: `Review ${localId}`,
      options: [
        skipOption(change),
        installOption(localId, change, pack, entry, resolution.problems.get(identity)),
      ],
      prompt: reviewPrompt(localId, change, pack, entry),
    },
  ];
}

/**
 * What this review is asking the user to accept.
 *
 * `"switch"` keeps a rollback from being labelled an upgrade: the source moved, but not forward.
 */
type RevisionChange = "install" | "switch" | "update";

const CHANGE_VERBS: Readonly<Record<RevisionChange, string>> = Object.freeze({
  install: "Install",
  switch: "Switch to",
  update: "Update to",
});

function revisionChange(
  previous: AuraManifestSkill | undefined,
  pack: ResolvedSkillPack | undefined,
): RevisionChange {
  if (previous === undefined) {
    return "install";
  }
  if (pack === undefined) {
    return "update";
  }
  return managedContentRevisionStatus(
    previous.version,
    previous.treeHash,
    pack.version,
    pack.treeHash,
  ) === "update"
    ? "update"
    : "switch";
}

function skipOption(change: RevisionChange): WizardOption {
  return {
    description:
      change === "install"
        ? "Leave this skill out of the plan."
        : "Keep the installed version and its manifest entry.",
    label: change === "install" ? "Skip — do not install" : "Skip — keep the installed version",
    value: "skip",
  };
}

function reviewPrompt(
  localId: string,
  change: RevisionChange,
  pack: ResolvedSkillPack | undefined,
  entry: SkillCatalogEntry | undefined,
): string {
  const sourceName = entry?.sourceName ?? "its directory";
  if (pack === undefined) {
    return `"${localId}" could not be fetched from ${sourceName}.`;
  }
  return (
    `${CHANGE_VERBS[change]} "${pack.name}" ${pack.version} from ${sourceName}? ` +
    "Press p on the install row to read its full SKILL.md before deciding."
  );
}

function installOption(
  localId: string,
  change: RevisionChange,
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
    description: pack.originUrl ?? entry?.sourceUrl ?? entry?.sourceName ?? "",
    label: `${CHANGE_VERBS[change]} ${localId} ${pack.version}`,
    preview: pack.files.find((file) => file.path === "SKILL.md")?.content,
    value: "install",
  };
}
