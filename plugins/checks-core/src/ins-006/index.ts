import { resolve } from "node:path";

import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";

import { guidedFix } from "./fix.js";
import { buildInstructionGraph, findDepthOverflows, findInstructionCycles } from "./graph.js";
import {
  isWithin,
  linkReporting,
  observedLinks,
  perSource,
  structuralId,
  IMPORT_SUPPORT,
  type LinkReporting,
  type ObservedLink,
} from "./links.js";

const DEPTH_LIMITS: ReadonlyMap<string, number> = new Map([["claude-code", 5]]);

/** How many paths one finding carries, so a hostile chain cannot inflate the report. */
const MAX_REPORTED_PATHS = 100;

export const instructionLinkIntegrityCheck = defineCheck({
  defaultSeverity: "error",
  detect: detectLinkProblems,
  explain:
    "Instruction imports must point to files the application can load without cycles or excessive nesting. Broken or unsupported chains silently discard guidance and can leave an agent running with only part of the intended instructions.",
  fix: guidedFix,
  fixability: "guided",
  id: "INS-006",
  scope: "global",
  title: "Instruction links are valid and supported",
});

function detectLinkProblems(model: WorkspaceModel): readonly DetectedFinding[] {
  const graph = buildInstructionGraph(model.instructionFiles);
  const reporting = linkReporting(model);
  return [
    ...targetFindings(model, reporting),
    ...findInstructionCycles(graph).map(cycleFinding),
    ...model.apps.flatMap((app) => depthFindings(app, graph)),
    ...model.apps.flatMap(unsupportedImportFindings),
  ];
}

/**
 * Reports what each declared link resolved to, one finding per source until the cap.
 *
 * Links an application cannot activate are left to {@link unsupportedImportFindings}: whether a
 * file Codex never opens exists is not something to fail a run over, and saying so twice under two
 * severities tells the user to fix a path that was never read.
 */
function targetFindings(
  model: WorkspaceModel,
  reporting: LinkReporting,
): readonly DetectedFinding[] {
  const links = observedLinks(model.instructionFiles).filter(
    (link) => !(link.kind === "import" && reporting.inertImports.has(link.sourcePath)),
  );
  const untrusted = new Set(
    model.instructionFiles
      .filter((document) => document.scope === "project")
      .map((document) => resolve(document.path)),
  );

  return perSource(
    links,
    (link) =>
      untrusted.has(link.sourcePath) && !isWithin(link.targetPath, reporting.roots)
        ? outsideFinding(link)
        : missingFinding(link),
    "missing",
  );
}

function missingFinding(link: ObservedLink): DetectedFinding | undefined {
  if (link.valid) {
    return undefined;
  }
  return {
    details: `Create ${link.targetPath}, correct the reference in ${link.sourcePath}, or remove the reference.`,
    id: structuralId("missing", [link.sourcePath, link.targetPath, link.kind]),
    locations: [{ path: link.sourcePath }],
    message: `${link.sourcePath} links to missing file ${link.targetPath}.`,
    metadata: {
      failure: "missing",
      sourcePath: link.sourcePath,
      targetPath: link.targetPath,
    },
  };
}

/**
 * Reports an out-of-bounds reference without saying whether it resolved.
 *
 * Emitted whether or not the target exists, which is the point: the finding describes the
 * reference the repository wrote, and reveals nothing about the machine reading it.
 */
function outsideFinding(link: ObservedLink): DetectedFinding {
  return {
    details:
      "Aura only resolves references that stay inside the project or the directories instruction files live in. Point the reference inside the project, or remove it.",
    id: structuralId("outside", [link.sourcePath, link.targetPath, link.kind]),
    locations: [{ path: link.sourcePath }],
    message: `${link.sourcePath} references ${link.targetPath}, which is outside the project and instruction directories.`,
    metadata: {
      failure: "outside",
      sourcePath: link.sourcePath,
      targetPath: link.targetPath,
    },
    severity: "warn",
  };
}

function cycleFinding(paths: readonly string[]): DetectedFinding {
  const uniquePaths = paths.slice(0, -1);
  return {
    details: `Cycle: ${describeChain(paths)}. Remove or redirect at least one reference.`,
    id: structuralId("cycle", uniquePaths),
    locations: uniquePaths.slice(0, MAX_REPORTED_PATHS).map((path) => ({ path })),
    message: `Instruction imports form a cycle across ${String(uniquePaths.length)} file(s).`,
    // The closing repeat of the first path is what makes the chain readable as a cycle, so the
    // bound is applied to the whole walk rather than to the distinct files inside it.
    metadata: { failure: "cycle", paths: paths.slice(0, MAX_REPORTED_PATHS) },
  };
}

function depthFindings(
  app: AppModel,
  graph: ReturnType<typeof buildInstructionGraph>,
): readonly DetectedFinding[] {
  const limit = DEPTH_LIMITS.get(app.adapterId);
  if (limit === undefined) {
    return [];
  }
  const roots = app.instructionFiles.map((document) => document.path);
  return findDepthOverflows(graph, roots, limit).map((overflow) => ({
    details: `Chain: ${describeChain(overflow.paths)}. Flatten or shorten it to at most ${String(limit)} import hops.`,
    id: structuralId("depth", [app.adapterId, overflow.rootPath, ...overflow.paths]),
    locations: [{ path: overflow.rootPath }],
    message: `${app.displayName} instruction imports exceed its ${String(limit)}-hop limit from ${overflow.rootPath}.`,
    metadata: {
      appId: app.adapterId,
      failure: "depth",
      limit,
      paths: overflow.paths.slice(0, MAX_REPORTED_PATHS),
      rootPath: overflow.rootPath,
    },
  }));
}

function unsupportedImportFindings(app: AppModel): readonly DetectedFinding[] {
  if (IMPORT_SUPPORT.get(app.adapterId) !== false) {
    return [];
  }
  const links = observedLinks(app.instructionFiles).filter((link) => link.kind === "import");
  return perSource(
    links,
    (link) => ({
      details: `${app.displayName} does not load import directives from this file. Remove the directive or use the application's native instruction mechanism.`,
      id: structuralId("unsupported", [app.adapterId, link.sourcePath, link.targetPath]),
      locations: [{ path: link.sourcePath }],
      message: `${link.sourcePath} contains an import that ${app.displayName} does not support.`,
      metadata: {
        appId: app.adapterId,
        failure: "unsupported",
        sourcePath: link.sourcePath,
        targetPath: link.targetPath,
      },
      severity: "warn",
    }),
    "unsupported",
  );
}

function describeChain(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_REPORTED_PATHS).join(" -> ");
  return paths.length > MAX_REPORTED_PATHS ? `${shown} -> …` : shown;
}
