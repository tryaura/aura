import { basename, resolve } from "node:path";

import { splitSourceLines, type Scope } from "@tryaura/aura-sdk";

import type { DuplicateCluster, InstructionSource } from "../instructions.js";
import { SETUP_ABORTED } from "../types.js";
import { selectedValues, type WizardIo, type WizardQuestion } from "../wizard-types.js";

/** How much of a paragraph one option shows before it is cut short. */
const EXCERPT_LIMIT = 120;

/**
 * Decides which copy of each duplicated paragraph survives consolidation.
 *
 * Only clusters with more than one selected copy are worth deciding: once the sources are
 * narrowed, a cluster whose other members were deselected has nothing left to choose between.
 * Identical clusters are settled without a question — every option holds the same bytes, so the
 * first member in sorted order wins, which is the answer the question's `initial` would propose.
 * Only genuinely divergent copies reach the user.
 */
export async function gatherDuplicateWinners(
  scope: Scope,
  selectedSources: readonly string[],
  sources: readonly InstructionSource[],
  clusters: readonly DuplicateCluster[],
  io: WizardIo,
): Promise<Readonly<Record<string, string>> | typeof SETUP_ABORTED> {
  const selected = new Set(selectedSources.map((path) => resolve(path)));
  const relevant = clusters
    .map((cluster) => ({
      ...cluster,
      members: cluster.members.filter((member) => selected.has(resolve(member.path))),
    }))
    .filter((cluster) => cluster.members.length > 1);
  const settled = relevant.flatMap((cluster) =>
    cluster.identical && cluster.members[0] !== undefined
      ? [[cluster.id, cluster.members[0].id]]
      : [],
  );
  const divergent = relevant.filter((cluster) => !cluster.identical);
  if (divergent.length === 0) {
    return Object.fromEntries(settled);
  }

  const questions: WizardQuestion[] = divergent.map((cluster, index) => ({
    id: `${scope}-duplicate-${String(index)}`,
    initial: cluster.members[0] === undefined ? [] : [cluster.members[0].id],
    kind: "select",
    label: `Duplicate ${String(index + 1)}`,
    options: cluster.members.map((member) => ({
      description: excerpt(sources, member.path, member.startLine, member.endLine),
      label: `${basename(member.path)}:${String(member.startLine)}-${String(member.endLine)}`,
      value: member.id,
    })),
    prompt: `These paragraphs are at least ${String(cluster.similarity)}% similar. Which version should Aura keep?`,
  }));
  const result = await io.ask(questions);
  if (result === "aborted") {
    return SETUP_ABORTED;
  }
  return Object.fromEntries([
    ...settled,
    ...divergent.flatMap((cluster, index) => {
      const winner = selectedValues(result[`${scope}-duplicate-${String(index)}`])[0];
      return winner === undefined ? [] : [[cluster.id, winner]];
    }),
  ]);
}

function excerpt(
  sources: readonly InstructionSource[],
  path: string,
  startLine: number,
  endLine: number,
): string {
  const source = sources.find((candidate) => resolve(candidate.path) === resolve(path));
  if (source === undefined) {
    return "Instruction paragraph";
  }
  const text = [...splitSourceLines(source.content)]
    .filter((line) => line.number >= startLine && line.number <= endLine)
    .map((line) => line.text.trim())
    .join(" ")
    .replace(/\s+/gu, " ");
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT - 3)}...` : text;
}
