import { basename, resolve } from "node:path";

import { splitSourceLines, type Scope } from "@tryaura/aura-sdk";

import type { DuplicateCluster, InstructionSource } from "../instructions.js";
import { SETUP_ABORTED } from "../types.js";
import {
  selectedValues,
  type WizardAnswers,
  type WizardIo,
  type WizardQuestion,
} from "../wizard-types.js";

/** How much of a paragraph one option shows before it is cut short. */
const EXCERPT_LIMIT = 120;

/** Clusters with more than one selected copy, including identical clusters settled silently. */
export function relevantDuplicateClusters(
  selectedSources: readonly string[],
  clusters: readonly DuplicateCluster[],
): readonly DuplicateCluster[] {
  const selected = new Set(selectedSources.map((path) => resolve(path)));
  return clusters
    .map((cluster) => ({
      ...cluster,
      members: cluster.members.filter((member) => selected.has(resolve(member.path))),
    }))
    .filter((cluster) => cluster.members.length > 1);
}

/** One question per divergent cluster; byte-identical copies need no user decision. */
export function duplicateQuestions(
  scope: Scope,
  relevant: readonly DuplicateCluster[],
  sources: readonly InstructionSource[],
  winners: Readonly<Record<string, string>>,
): readonly WizardQuestion[] {
  return relevant.filter((cluster) => !cluster.identical).map((cluster, index) => ({
    compactLabel: `Dup ${String(index + 1)}`,
    id: `${scope}-duplicate-${String(index)}`,
    initial: initialWinner(cluster, winners),
    kind: "select",
    label: `Duplicate ${String(index + 1)}`,
    options: cluster.members.map((member) => ({
      description: excerpt(sources, member.path, member.startLine, member.endLine),
      label: `${basename(member.path)}:${String(member.startLine)}-${String(member.endLine)}`,
      value: member.id,
    })),
    prompt: `These paragraphs are at least ${String(cluster.similarity)}% similar. Which version should Aura keep?`,
  }));
}

export function parseDuplicateWinners(
  scope: Scope,
  relevant: readonly DuplicateCluster[],
  answers: WizardAnswers,
): Readonly<Record<string, string>> {
  const settled = relevant.flatMap((cluster) => {
    const first = cluster.members[0];
    return cluster.identical && first !== undefined ? [[cluster.id, first.id]] : [];
  });
  const divergent = relevant.filter((cluster) => !cluster.identical);
  return Object.fromEntries([
    ...settled,
    ...divergent.flatMap((cluster, index) => {
      const winner = selectedValues(answers[`${scope}-duplicate-${String(index)}`])[0];
      return winner === undefined ? [] : [[cluster.id, winner]];
    }),
  ]);
}

/** Compatibility entry point for the single-pass gatherer used by focused tests. */
export async function gatherDuplicateWinners(
  scope: Scope,
  selectedSources: readonly string[],
  sources: readonly InstructionSource[],
  clusters: readonly DuplicateCluster[],
  io: WizardIo,
): Promise<Readonly<Record<string, string>> | typeof SETUP_ABORTED> {
  const relevant = relevantDuplicateClusters(selectedSources, clusters);
  const questions = duplicateQuestions(scope, relevant, sources, {});
  if (questions.length === 0) {
    return parseDuplicateWinners(scope, relevant, {});
  }
  const answers = await io.ask(questions);
  return answers === "aborted" || answers === "back"
    ? SETUP_ABORTED
    : parseDuplicateWinners(scope, relevant, answers);
}

/** The previously chosen winner when it is still on offer, else the first member. */
function initialWinner(
  cluster: DuplicateCluster,
  winners: Readonly<Record<string, string>>,
): readonly string[] {
  const kept = winners[cluster.id];
  if (kept !== undefined && cluster.members.some((member) => member.id === kept)) {
    return [kept];
  }
  return cluster.members[0] === undefined ? [] : [cluster.members[0].id];
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
