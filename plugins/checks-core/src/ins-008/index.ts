import { resolve } from "node:path";

import {
  defineCheck,
  type DetectedFinding,
  type InstructionDocument,
  type JsonObject,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { sha256 } from "../hashing.js";
import {
  extractParagraphs,
  paragraphHashBuckets,
  type InstructionParagraph,
} from "../instruction-paragraphs.js";
import { displayInstructionPath, instructionLineRange } from "../instruction-paths.js";
import {
  collectAxisHits,
  findAxisConflicts,
  isCrossScopeConflict,
  type AxisConflict,
} from "../ins-005/hits.js";
import { projectSpecificSignals, type ProjectSignal } from "./project-signals.js";

interface ParagraphLocation extends JsonObject {
  readonly endLine: number;
  readonly path: string;
  readonly startLine: number;
}

interface DuplicatePair {
  readonly global: ParagraphLocation[];
  readonly globalPath: string;
  readonly project: ParagraphLocation[];
  readonly projectPath: string;
}

export const instructionPrecedenceCheck = defineCheck({
  defaultSeverity: "warn",
  detect: detectInstructionPrecedence,
  explain: `Global instructions should hold preferences that apply across repositories, while project instructions should own repository standards. Repetition, contradictions, or project-only guidance in the global tier make precedence harder to predict and personal configuration harder to reuse.

Move repository names, commands, and package-specific rules into the project tier, then remove global copies of project guidance. Where tiers intentionally differ, state the project exception explicitly so the precedence is understandable.`,
  fixability: "manual",
  id: "INS-008",
  scope: "project",
  title: "Instruction guidance respects global and project precedence",
});

function detectInstructionPrecedence(model: WorkspaceModel): readonly DetectedFinding[] {
  if (model.projectRoot === undefined || model.repository === undefined) {
    return [];
  }

  const duplicateFindings = duplicatePairs(model.instructionFiles).map((pair) =>
    findingForDuplicate(pair, model),
  );
  const contradictionFindings = findAxisConflicts(collectAxisHits(model.instructionFiles))
    .filter(isCrossScopeConflict)
    .map((conflict) => findingForContradiction(conflict, model));
  const projectSpecificFindings = projectSpecificSignals(
    model.instructionFiles,
    model.repository.packageManifests ?? [],
  ).map(([document, signals]) => findingForProjectSignals(document, signals, model));

  return [...duplicateFindings, ...contradictionFindings, ...projectSpecificFindings];
}

function duplicatePairs(documents: readonly InstructionDocument[]): readonly DuplicatePair[] {
  const paragraphs = extractParagraphs(documents);
  const pairs = new Map<string, DuplicatePair>();

  for (const indexes of paragraphHashBuckets(paragraphs).values()) {
    const globals = indexes.flatMap((index) => {
      const paragraph = paragraphs[index];
      return paragraph?.scope === "global" ? [paragraph] : [];
    });
    const projects = indexes.flatMap((index) => {
      const paragraph = paragraphs[index];
      return paragraph?.scope === "project" ? [paragraph] : [];
    });
    for (const global of globals) {
      for (const project of projects) {
        const key = `${global.path}\0${project.path}`;
        const pair = pairs.get(key) ?? {
          global: [],
          globalPath: global.path,
          project: [],
          projectPath: project.path,
        };
        addParagraphLocation(pair.global, global);
        addParagraphLocation(pair.project, project);
        pairs.set(key, pair);
      }
    }
  }

  return [...pairs.values()].sort(
    (left, right) =>
      left.globalPath.localeCompare(right.globalPath) ||
      left.projectPath.localeCompare(right.projectPath),
  );
}

function addParagraphLocation(
  locations: ParagraphLocation[],
  paragraph: InstructionParagraph,
): void {
  if (
    locations.some(
      (location) =>
        location.path === paragraph.path &&
        location.startLine === paragraph.startLine &&
        location.endLine === paragraph.endLine,
    )
  ) {
    return;
  }
  locations.push({
    endLine: paragraph.endLine,
    path: paragraph.path,
    startLine: paragraph.startLine,
  });
  locations.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine,
  );
}

function findingForDuplicate(pair: DuplicatePair, model: WorkspaceModel): DetectedFinding {
  const global = pair.global[0];
  const project = pair.project[0];
  const globalDescription =
    global === undefined
      ? displayInstructionPath(pair.globalPath, model)
      : `${displayInstructionPath(pair.globalPath, model)}:${instructionLineRange(global.startLine, global.endLine)}`;
  const projectDescription =
    project === undefined
      ? displayInstructionPath(pair.projectPath, model)
      : `${displayInstructionPath(pair.projectPath, model)}:${instructionLineRange(project.startLine, project.endLine)}`;
  return {
    details: `Copies: ${globalDescription}, ${projectDescription}. Keep the guidance in the project file only when it is repository-specific.`,
    id: `duplicate:${sha256(`${pair.globalPath}\0${pair.projectPath}`)}`,
    locations: [...pair.global, ...pair.project].map((location) => ({
      line: location.startLine,
      path: location.path,
    })),
    message: "Project instructions repeat guidance from global instructions.",
    metadata: {
      global: pair.global,
      kind: "duplicate",
      project: pair.project,
    },
  };
}

function findingForContradiction(conflict: AxisConflict, model: WorkspaceModel): DetectedFinding {
  const global = conflict.left.scope === "global" ? conflict.left : conflict.right;
  const project = conflict.left.scope === "project" ? conflict.left : conflict.right;
  return {
    details: `Locations: ${displayInstructionPath(global.path, model)}:${String(global.line)}, ${displayInstructionPath(project.path, model)}:${String(project.line)}. Resolve the project rule explicitly or remove the conflicting global preference.`,
    id: `contradiction:${conflict.axis}:${sha256(`${global.path}\0${project.path}`)}`,
    locations: [
      { line: global.line, path: global.path },
      { line: project.line, path: project.path },
    ],
    message: "Project instructions contradict global guidance.",
    metadata: {
      axis: conflict.axis,
      global: { line: global.line, path: global.path },
      kind: "contradiction",
      project: { line: project.line, path: project.path },
    },
  };
}

function findingForProjectSignals(
  document: InstructionDocument,
  signals: readonly ProjectSignal[],
  model: WorkspaceModel,
): DetectedFinding {
  const lines = [...new Set(signals.map((signal) => signal.line))].sort(
    (left, right) => left - right,
  );
  const path = resolve(document.path);
  return {
    details: `Repository-specific guidance appears at ${displayInstructionPath(path, model)}:${lines.join(",")}. Move it to the project AGENTS.md or equivalent project instruction file.`,
    id: `project-specific:${sha256(path)}`,
    locations: lines.map((line) => ({ line, path })),
    message: "A global instruction file contains repository-specific guidance.",
    metadata: {
      kind: "project-specific",
      path,
      signals,
    },
    // Every signal is a heuristic, and one of them alone is as likely to be a turn of phrase that
    // happens to read like a path or a package name. Corroboration earns the check's warning; a
    // lone signal is reported where a false positive costs the user nothing.
    ...(signals.length > 1 ? {} : { severity: "info" as const }),
  };
}
