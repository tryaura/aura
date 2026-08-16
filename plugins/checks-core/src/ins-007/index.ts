import { Buffer } from "node:buffer";
import { extname, resolve } from "node:path";

import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type FindingMetadataTablePresentation,
  type InstructionDocument,
  type JsonObject,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import {
  instructionGraphFor,
  reachableInstructionPaths,
  type InstructionGraph,
} from "../ins-006/graph.js";
import { DEPTH_LIMITS } from "../ins-006/links.js";

export const DEFAULT_CONTEXT_BUDGET_BYTES = 32_000;
export const LARGE_CONTEXT_BUDGET_BYTES = 80_000;

/**
 * How many files one finding lists before the rest are summarized.
 *
 * The instruction set arrives with whatever repository the user checked out, and core will list up
 * to ten thousand rule files from a single directory. The largest files are the ones worth acting
 * on, and a table nobody can scroll past is not a report — so the total is stated in the message
 * and the rows stop here.
 */
const MAX_REPORTED_FILES = 100;

interface BudgetFile {
  readonly bytes: number;
  readonly conditional?: true | undefined;
  readonly path: string;
  /**
   * Fraction of the always-loaded total this file accounts for.
   *
   * Absent for conditional files: they are not part of that total, so every fraction of it they
   * could be given would describe something other than what the column says.
   */
  readonly share?: number | undefined;
}

interface ClassifiedDocuments {
  readonly conditional: readonly InstructionDocument[];
  readonly effective: readonly InstructionDocument[];
}

const PRESENTATION: FindingMetadataTablePresentation = {
  columns: [
    { heading: "File", key: "path" },
    { align: "right", format: "integer", heading: "Bytes", key: "bytes" },
    { align: "right", format: "percentage", heading: "Share", key: "share" },
    {
      format: "boolean",
      heading: "Loading",
      key: "conditional",
      trueLabel: "conditional — not always loaded",
    },
  ],
  kind: "metadata-table",
  rowsKey: "files",
};

export const instructionContextBudgetCheck = defineCheck({
  defaultSeverity: "info",
  detect: contextBudgetFindings,
  explain:
    "Large always-loaded instruction sets consume context before an agent begins the task, leaving less room for code, tool results, and reasoning. Start with the largest files, remove duplicate guidance reported by INS-003, and repair dead or unnecessary imports reported by INS-006.",
  fixability: "manual",
  id: "INS-007",
  scope: "global",
  title: "Instruction context stays within a practical budget",
});

function contextBudgetFindings(model: WorkspaceModel): readonly DetectedFinding[] {
  const graph = instructionGraphFor(model.instructionFiles);
  const workspaceDocuments = documentMap(model.instructionFiles);

  return model.apps.flatMap((app) => {
    if (app.synthetic === true) {
      return [];
    }
    const classified = classifyDocuments(app, graph, workspaceDocuments);
    const finding = classified === undefined ? unmodeledFinding(app) : findingFor(app, classified);
    return finding === undefined ? [] : [finding];
  });
}

/**
 * Says that an application was not measured, once its files are large enough for that to matter.
 *
 * Which files an application actually loads is something Aura has to know per application, and a
 * check that silently passes for the ones it does not know reads as "your budget is fine" to the
 * one user who most needs to hear otherwise. Below the budget there is nothing to warn about
 * whatever the loading rules turn out to be, so the gap is only worth naming above it.
 */
function unmodeledFinding(app: AppModel): DetectedFinding | undefined {
  const totalBytes = app.instructionFiles.reduce(
    (total, document) => total + Buffer.byteLength(document.content, "utf8"),
    0,
  );
  if (totalBytes <= DEFAULT_CONTEXT_BUDGET_BYTES) {
    return undefined;
  }
  return {
    details:
      "Aura measures applications whose instruction loading it models. Until this one is modeled, treat the total as an upper bound and check by hand which of these files the application always loads.",
    id: app.adapterId,
    message: `${app.displayName} has approximately ${String(Math.ceil(totalBytes / 4))} tokens of instruction files, and Aura does not model how it loads them.`,
    metadata: { appId: app.adapterId, evaluated: false, totalBytes },
  };
}

function classifyDocuments(
  app: AppModel,
  graph: InstructionGraph,
  workspaceDocuments: ReadonlyMap<string, InstructionDocument>,
): ClassifiedDocuments | undefined {
  const appDocuments = documentMap(app.instructionFiles);
  if (app.adapterId === "codex") {
    return { conditional: [], effective: [...appDocuments.values()] };
  }
  if (app.adapterId === "claude-code") {
    const maximumHops = DEPTH_LIMITS.get(app.adapterId);
    return {
      conditional: [],
      effective: documentsAtPaths(
        reachableInstructionPaths(graph, [...appDocuments.keys()], { maximumHops }),
        appDocuments,
        workspaceDocuments,
      ),
    };
  }
  if (app.adapterId === "cursor") {
    const conditional = [...appDocuments.values()].filter(isConditionalCursorRule);
    const excluded = new Set(conditional.map((document) => resolve(document.path)));
    const roots = [...appDocuments.values()]
      .filter((document) => !isConditionalCursorRule(document))
      .map((document) => document.path);
    const effective = documentsAtPaths(
      reachableInstructionPaths(graph, roots, { excluded }),
      appDocuments,
      workspaceDocuments,
    );
    return { conditional, effective };
  }
  return undefined;
}

function documentMap(
  documents: readonly InstructionDocument[],
): ReadonlyMap<string, InstructionDocument> {
  const result = new Map<string, InstructionDocument>();
  // Resolved once per document rather than once per comparison: the list is every instruction file
  // in the workspace, which core will happily hand over ten thousand of.
  const sorted = documents
    .map((document) => ({ document, path: resolve(document.path) }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.document.sourceId.localeCompare(right.document.sourceId) ||
        left.document.content.localeCompare(right.document.content),
    );
  for (const { document, path } of sorted) {
    if (!result.has(path)) {
      result.set(path, document);
    }
  }
  return result;
}

function documentsAtPaths(
  paths: readonly string[],
  appDocuments: ReadonlyMap<string, InstructionDocument>,
  workspaceDocuments: ReadonlyMap<string, InstructionDocument>,
): readonly InstructionDocument[] {
  return paths.flatMap((path) => {
    const document = appDocuments.get(path) ?? workspaceDocuments.get(path);
    return document === undefined ? [] : [document];
  });
}

function isConditionalCursorRule(document: InstructionDocument): boolean {
  return (
    extname(document.path).toLowerCase() === ".mdc" && document.metadata?.["alwaysApply"] !== true
  );
}

function findingFor(app: AppModel, classified: ClassifiedDocuments): DetectedFinding | undefined {
  const effective = classified.effective.map(measureDocument);
  const totalBytes = effective.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes <= DEFAULT_CONTEXT_BUDGET_BYTES) {
    return undefined;
  }

  const effectiveFiles: BudgetFile[] = effective.map((file) => ({
    ...file,
    share: file.bytes / totalBytes,
  }));
  const conditionalFiles: BudgetFile[] = classified.conditional.map((document) => ({
    ...measureDocument(document),
    conditional: true,
  }));
  const breakdown = [...effectiveFiles, ...conditionalFiles].sort(
    (left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path),
  );
  const files: readonly JsonObject[] = breakdown.slice(0, MAX_REPORTED_FILES).map((file) => ({
    bytes: file.bytes,
    ...(file.conditional === true ? { conditional: true } : {}),
    path: file.path,
    ...(file.share === undefined ? {} : { share: file.share }),
  }));
  const omittedFiles = breakdown.length - files.length;
  const approxTokens = Math.ceil(totalBytes / 4);
  const veryLarge = totalBytes > LARGE_CONTEXT_BUDGET_BYTES;

  return {
    details: [
      veryLarge
        ? "This instruction set is well above the recommended context budget. Consolidate or move narrowly applicable guidance before it crowds out task context."
        : "Review the largest files first and move narrowly applicable guidance out of the always-loaded set.",
      ...(omittedFiles === 0
        ? []
        : [
            `Listing the ${String(MAX_REPORTED_FILES)} largest of ${String(breakdown.length)} file(s).`,
          ]),
    ].join(" "),
    id: app.adapterId,
    message: `${app.displayName} loads approximately ${String(approxTokens)} tokens of always-on instructions across ${String(effective.length)} file(s)${conditionalSuffix(conditionalFiles.length)}.`,
    metadata: {
      approxTokens,
      files,
      ...(omittedFiles === 0 ? {} : { omittedFiles }),
      totalBytes,
    },
    presentation: PRESENTATION,
  };
}

/** Names the conditional files the table lists, so the message and the table agree on the count. */
function conditionalSuffix(count: number): string {
  return count === 0 ? "" : `, and lists ${String(count)} conditional file(s) alongside them`;
}

function measureDocument(document: InstructionDocument): Omit<BudgetFile, "share"> {
  return { bytes: Buffer.byteLength(document.content, "utf8"), path: resolve(document.path) };
}
