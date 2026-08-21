import { dirname, join } from "node:path";

import { splitSourceLines, type GitignoreModel } from "@tryaura/aura-sdk";

const BEGIN = "# aura:begin ENV-003";
const END = "# aura:end ENV-003";

/** Whether an earlier release's managed block is still in the file, and whether it is intact. */
export type AbandonedBlock = "complete" | "partial";

/**
 * Finds the managed block earlier Aura releases wrote into a repository's `.gitignore`.
 *
 * Aura used to maintain this block itself and no longer writes to repository files at all. Left
 * unmentioned, the markers are the worst of both: they carry Aura's name, so a reader assumes Aura
 * still keeps them current, and nothing ever will. Naming them once is what lets someone decide to
 * keep the rules as their own or delete them.
 *
 * A lone marker counts. A half-removed block is still a block somebody has to finish removing, and
 * the reconciler that used to repair one is gone.
 */
export function abandonedBlock(gitignore: GitignoreModel): AbandonedBlock | undefined {
  const markers = new Set(
    [...splitSourceLines(gitignore.content ?? "")]
      .map((line) => line.text.trim())
      .filter((text) => text === BEGIN || text === END),
  );
  if (markers.size === 0) {
    return undefined;
  }
  return markers.has(BEGIN) && markers.has(END) ? "complete" : "partial";
}

/** How the block is described to the person who now owns it. */
export function abandonedBlockDetail(gitignorePath: string, block: AbandonedBlock): string {
  const extent =
    block === "complete"
      ? `The block runs from \`${BEGIN}\` to \`${END}\`.`
      : `One of the \`${BEGIN}\` / \`${END}\` markers is present without the other, so the block was already partly removed.`;
  const skills = join(dirname(gitignorePath), ".claude", "skills");
  return `${extent} Aura wrote it in an earlier release and no longer maintains it. Its rules are still valid Git rules, so keeping them is fine — delete the two marker comments so nothing implies Aura owns them, or delete the whole block. One of its rules, \`/.claude/skills/\`, ignored the per-project skill links Aura also no longer creates; if ${skills} still holds symlinks into your home directory, they are leftovers you can remove.`;
}
