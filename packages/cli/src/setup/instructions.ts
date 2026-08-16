import { Buffer } from "node:buffer";
import { relative, resolve } from "node:path";

import {
  splitSourceLines,
  type Finding,
  type InstructionDocument,
  type Scope,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { projectSharedInstructionsPath } from "@tryaura/core";

import type { InstructionScopeSelection } from "./types.js";

/**
 * One instruction file the wizard may consolidate.
 *
 * Carries no derived size or line count: the inventory is built once per step and again per plan,
 * and measuring every instruction file on a machine twice to fill in a description the planner
 * never reads is work for nothing. {@link describeInstructionSource} measures the few that are
 * actually shown.
 */
export interface InstructionSource {
  readonly content: string;
  readonly path: string;
  readonly scope: Scope;
}

interface DuplicateMember {
  readonly endLine: number;
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
}

export interface DuplicateCluster {
  readonly id: string;
  readonly members: readonly DuplicateMember[];
  readonly similarity: number;
}

export function instructionTargets(model: WorkspaceModel): Readonly<Record<Scope, string>> {
  return {
    global: resolve(model.sharedInstructions.path),
    // Core's helper, not a second spelling of the same filename: an adapter's project link is
    // resolved against it, and a target the wizard writes elsewhere would be linked to nothing.
    project: resolve(projectSharedInstructionsPath(model.projectRoot, model.cwd)),
  };
}

export function instructionInventory(model: WorkspaceModel): readonly InstructionSource[] {
  const targets = instructionTargets(model);
  const owned = new Set(
    model.manifest.status === "ready"
      ? Object.values(model.manifest.value.ownership).flatMap((entry) =>
          entry.files.map((path) => resolve(path)),
        )
      : [],
  );
  const documents = new Map<string, InstructionDocument>();

  for (const document of model.instructionFiles) {
    const path = resolve(document.path);
    if (path === targets.global || path === targets.project || owned.has(path)) {
      continue;
    }
    const current = documents.get(path);
    if (current === undefined || document.content.length > current.content.length) {
      documents.set(path, document);
    }
  }

  return [...documents.values()]
    .map((document) => ({
      content: document.content,
      path: resolve(document.path),
      scope: document.scope,
    }))
    .sort(
      (left, right) => left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path),
    );
}

/** How much text one source carries, measured only for the sources a form actually shows. */
export function describeInstructionSource(source: InstructionSource): string {
  const lineCount = [...splitSourceLines(source.content)].length;
  const size = Buffer.byteLength(source.content, "utf8");
  return `${String(lineCount)} lines, ${String(size)} bytes`;
}

export function instructionTargetSource(
  model: WorkspaceModel,
  scope: Scope,
  path: string,
): InstructionSource | undefined {
  const content =
    scope === "global" && resolve(path) === resolve(model.sharedInstructions.path)
      ? model.sharedInstructions.content
      : model.instructionFiles.find((document) => resolve(document.path) === resolve(path))
          ?.content;
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  return { content, path: resolve(path), scope };
}

export function duplicateClusters(findings: readonly Finding[]): readonly DuplicateCluster[] {
  return findings
    .filter((finding) => finding.checkId === "INS-003")
    .flatMap((finding) => {
      const values = finding.metadata?.["members"];
      if (!Array.isArray(values)) {
        return [];
      }
      const members = values.flatMap(parseMember);
      if (members.length < 2) {
        return [];
      }
      const matches = finding.metadata?.["matches"];
      const similarities = Array.isArray(matches)
        ? matches.flatMap((match) =>
            isRecord(match) && typeof match["similarity"] === "number" ? [match["similarity"]] : [],
          )
        : [];
      return [{ id: finding.id, members, similarity: Math.min(...similarities, 100) }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Merges the selected sources into what the target should contain.
 *
 * Convergent by construction, because setup's contract is that the fifth run is the first run. The
 * existing target is carried through verbatim as the base rather than nested under a provenance
 * heading of its own, and a source whose heading is already in that base is left out: without both,
 * keeping the originals in place means every re-run appends the same guidance one level deeper.
 */
export function composeConsolidatedInstructions(
  sources: readonly InstructionSource[],
  selection: InstructionScopeSelection,
  clusters: readonly DuplicateCluster[],
  model: WorkspaceModel,
  existingTarget?: InstructionSource,
): string {
  const selected = new Set(selection.selectedSources.map((path) => resolve(path)));
  const removals = loserRanges(selection, clusters);
  const base = existingTarget?.content ?? "";
  const sections = sources
    .filter((source) => selected.has(resolve(source.path)))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((source) => ({
      heading: provenanceHeading(source.path, selection.scope, model),
      text: removeRanges(source.content, removals.get(resolve(source.path)) ?? []),
    }))
    // Matched with its line ending, so a merged `~/a.md.bak` cannot pass for a merged `~/a.md`.
    .filter((section) => !base.includes(`${section.heading}\n`))
    .map((section) => `${section.heading}\n\n${section.text}`);

  const body = [...(base.length === 0 ? [] : [base]), ...sections].join("\n\n---\n\n");
  return body.endsWith("\n") ? body : `${body}\n`;
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

export function archiveRelativePath(
  path: string,
  scope: Scope,
  model: WorkspaceModel,
): string | undefined {
  const root = scope === "global" ? model.homeDir : (model.projectRoot ?? model.cwd);
  const child = relative(root, path);
  if (child.length === 0 || child.split(/[\\/]/u).some((part) => part === "..")) {
    return undefined;
  }
  return `${scope === "global" ? "home" : "project"}/${child.replaceAll("\\", "/")}`;
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

function parseMember(value: unknown): readonly DuplicateMember[] {
  if (
    !isRecord(value) ||
    typeof value["path"] !== "string" ||
    typeof value["startLine"] !== "number" ||
    typeof value["endLine"] !== "number"
  ) {
    return [];
  }
  const path = resolve(value["path"]);
  const startLine = value["startLine"];
  const endLine = value["endLine"];
  return [{ endLine, id: `${path}:${String(startLine)}:${String(endLine)}`, path, startLine }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
