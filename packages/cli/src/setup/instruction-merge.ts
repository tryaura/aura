import { relative, resolve } from "node:path";

import { splitSourceLines, type Scope, type WorkspaceModel } from "@tryaura/aura-sdk";

import type { DuplicateCluster, DuplicateMember, InstructionSource } from "./instructions.js";
import type { InstructionScopeSelection } from "./types.js";

/** One selected source reduced to the block a merge would write for it. */
interface MergeSection {
  readonly heading: string;
  readonly path: string;
  readonly text: string;
}

/**
 * Merges the selected sources into what the target should contain.
 *
 * Convergent by construction, because setup's contract is that the fifth run is the first run. The
 * existing target is carried through verbatim as the base rather than nested under a provenance
 * heading of its own, and a source whose heading is already in that base is left out. That keeps a
 * source restored from an archive from being appended again on a later run.
 *
 * What that skip cannot decide is whether the file is still safe to archive; {@link unmergedSources}
 * answers that from the same sections.
 */
export function composeConsolidatedInstructions(
  sources: readonly InstructionSource[],
  selection: InstructionScopeSelection,
  clusters: readonly DuplicateCluster[],
  model: WorkspaceModel,
  existingTarget?: InstructionSource,
): string {
  const base = existingTarget?.content ?? "";
  const sections = mergeSections(sources, selection, clusters, model)
    // A source can lose every paragraph to copies kept elsewhere; a heading with nothing under it
    // would say the file contributed something it did not.
    .filter((section) => section.text.trim().length > 0)
    // Matched with its line ending, so a merged `~/a.md.bak` cannot pass for a merged `~/a.md`.
    .filter((section) => !base.includes(`${section.heading}\n`))
    .map((section) => `${section.heading}\n\n${section.text}`);

  const body = [...(base.length === 0 ? [] : [base]), ...sections].join("\n\n---\n\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Selected sources whose current text the merge leaves out, so archiving them would lose it.
 *
 * A section is dropped when its heading is already in the target, which is what stops a restored
 * source from being appended a second time. That is safe only while the target still holds what the
 * file says today: once it has been edited since the merge, the dropped section is the only copy,
 * and the archive consolidation performs would take it off disk without a line of it ever reaching
 * the target. Losing every paragraph to a duplicate winner is not that case — the text is in the
 * target already, under the winner's heading.
 */
export function unmergedSources(
  sources: readonly InstructionSource[],
  selection: InstructionScopeSelection,
  clusters: readonly DuplicateCluster[],
  model: WorkspaceModel,
  existingTarget?: InstructionSource,
): readonly string[] {
  const base = existingTarget?.content ?? "";
  return mergeSections(sources, selection, clusters, model)
    .filter(
      (section) =>
        section.text.trim().length > 0 &&
        base.includes(`${section.heading}\n`) &&
        !base.includes(`${section.heading}\n\n${section.text}`),
    )
    .map((section) => section.path);
}

/** The blocks a merge considers, before either caller decides what to do with them. */
function mergeSections(
  sources: readonly InstructionSource[],
  selection: InstructionScopeSelection,
  clusters: readonly DuplicateCluster[],
  model: WorkspaceModel,
): readonly MergeSection[] {
  const selected = new Set(selection.selectedSources.map((path) => resolve(path)));
  const removals = loserRanges(selection, clusters);
  return sources
    .filter((source) => selected.has(resolve(source.path)))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => ({
      heading: provenanceHeading(source.path, selection.scope, model),
      path: resolve(source.path),
      text: removeRanges(source.content, removals.get(resolve(source.path)) ?? []),
    }));
}

/**
 * Names where a merged block came from, without carrying the machine into the file.
 *
 * A project target is committed, so an absolute path there would publish the developer's username
 * and resolve to nothing on anyone else's checkout. The home tilde does the same job for a global
 * target, which is at least private but no more portable.
 */
function provenanceHeading(path: string, scope: Scope, model: WorkspaceModel): string {
  const root = scope === "global" ? model.homeDir : (model.projectRoot ?? model.cwd);
  const child = relative(root, path);
  const inside = child.length > 0 && !child.split(/[\\/]/u).includes("..");
  const label = inside
    ? `${scope === "global" ? "~/" : ""}${child.replaceAll("\\", "/")}`
    : resolve(path);
  return `# Instructions from ${label}`;
}

function loserRanges(
  selection: InstructionScopeSelection,
  clusters: readonly DuplicateCluster[],
): ReadonlyMap<string, readonly DuplicateMember[]> {
  const selected = new Set(selection.selectedSources.map((path) => resolve(path)));
  const byPath = new Map<string, DuplicateMember[]>();
  for (const cluster of clusters) {
    const members = cluster.members.filter((member) => selected.has(resolve(member.path)));
    if (members.length < 2) {
      continue;
    }
    const winner = selection.duplicateWinners[cluster.id] ?? members[0]?.id;
    for (const member of members) {
      if (member.id === winner) {
        continue;
      }
      const path = resolve(member.path);
      const ranges = byPath.get(path) ?? [];
      ranges.push(member);
      byPath.set(path, ranges);
    }
  }
  return byPath;
}

function removeRanges(content: string, ranges: readonly DuplicateMember[]): string {
  if (ranges.length === 0) {
    return content;
  }
  const removed = new Set<number>();
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      removed.add(line);
    }
  }
  return [...splitSourceLines(content)]
    .filter((line) => !removed.has(line.number))
    .map((line) => `${line.text}${line.ending}`)
    .join("");
}
