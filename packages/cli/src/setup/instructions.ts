import { relative, resolve } from "node:path";

import {
  splitSourceLines,
  type Finding,
  type InstructionDocument,
  type Scope,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { canonicalSourcePath, isAuraArtifact } from "./instruction-artifacts.js";

/**
 * One instruction file the wizard may consolidate.
 *
 * Carries no derived line count: the inventory is built once per step and again per plan, and
 * measuring every instruction file on a machine twice to fill in a description the planner never
 * reads is work for nothing. {@link describeInstructionSource} measures the few that are actually
 * shown.
 */
export interface InstructionSource {
  readonly content: string;
  readonly path: string;
  readonly scope: Scope;
}

export interface DuplicateMember {
  readonly endLine: number;
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
}

export interface DuplicateCluster {
  readonly id: string;
  /** True only when the check saw every pair of copies as an exact match. */
  readonly identical: boolean;
  readonly members: readonly DuplicateMember[];
  readonly similarity: number;
}

export function instructionTargets(model: WorkspaceModel): Readonly<{ global: string }> {
  return {
    global: resolve(model.sharedInstructions.path),
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
    // Both spellings are checked because either can be the alias: a symlinked entry canonicalizes
    // to the target, and an owned path recorded before a link moved still names the entry.
    const excluded = [path, canonicalSourcePath(document)].some(
      (candidate) => candidate === targets.global || owned.has(candidate),
    );
    if (excluded || isAuraArtifact(document, model)) {
      continue;
    }
    // Keyed canonically so two names for one physical file collapse into a single offer.
    const key = canonicalSourcePath(document);
    const current = documents.get(key);
    if (current === undefined || document.content.length > current.content.length) {
      documents.set(key, document);
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
  return `${String(lineCount)} ${pluralize(lineCount, "line")}`;
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

/**
 * Exact current contents of one setup target, including an empty file.
 *
 * Scoped like {@link instructionTargetSource}, which it is read beside in the planner: only the
 * global target is the shared-instruction source, and matching on path alone would hand a project
 * selection the global file's contents on a machine where the two paths coincide.
 */
export function instructionTargetContent(
  model: WorkspaceModel,
  scope: Scope,
  path: string,
): string | undefined {
  if (scope === "global" && resolve(path) === resolve(model.sharedInstructions.path)) {
    return model.sharedInstructions.content;
  }
  return model.instructionFiles.find((document) => resolve(document.path) === resolve(path))
    ?.content;
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
      // Taken from the finding rather than re-derived: `matches` is capped at the check's edge
      // limit, so a large cluster's list can look all-exact while the copies it dropped were not.
      // A finding that does not say is treated as near, which asks rather than silently choosing.
      return [
        {
          id: finding.id,
          identical: finding.metadata?.["identical"] === true,
          members,
          similarity: Math.min(...similarities, 100),
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
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
