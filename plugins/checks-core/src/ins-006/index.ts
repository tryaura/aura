import { resolve } from "node:path";

import {
  defineCheck,
  type AppModel,
  type DetectedFinding,
  type WorkspaceModel,
} from "@tryaura/aura-sdk";
import { pluralize } from "@tryaura/core/pluralize";

import { structuralFindingId } from "../finding-id.js";
import { instructionCapabilities } from "../instruction-capabilities.js";
import { displayInstructionPath } from "../instruction-paths.js";
import { guidedFix } from "./fix.js";
import { findDepthOverflows } from "./depth.js";
import {
  buildInstructionGraph,
  findInstructionCycles,
  instructionGraphFor,
  type InstructionGraph,
} from "./graph.js";
import {
  isWithin,
  linkReporting,
  observedLinks,
  perSource,
  type FailureKind,
  type LinkReporting,
  type ObservedLink,
} from "./links.js";

/** How many paths one finding carries, so a hostile chain cannot inflate the report. */
const MAX_REPORTED_PATHS = 100;

export const instructionLinkIntegrityCheck = defineCheck({
  defaultSeverity: "error",
  detect: detectLinkProblems,
  explain: `Instruction imports must point to files the application can load without cycles or excessive nesting. Broken or unsupported chains silently discard guidance and can leave an agent running with only part of the intended instructions.

Re-run the check with \`--fix --interactive\` to review the affected source and target paths. Create or correct missing targets, remove one edge from cycles, and flatten chains that exceed the named application's supported depth.`,
  fix: guidedFix,
  fixability: "guided",
  id: "INS-006",
  scope: "global",
  title: "Instruction links are valid and supported",
});

function detectLinkProblems(model: WorkspaceModel): readonly DetectedFinding[] {
  const graph = instructionGraphFor(model.instructionFiles);
  const reporting = linkReporting(model);
  const cycleGraph =
    reporting.inertImports.size === 0
      ? graph
      : buildInstructionGraph(model.instructionFiles, {
          excludedImportSources: reporting.inertImports,
        });
  return [
    ...targetFindings(model, reporting),
    ...findInstructionCycles(cycleGraph).map((paths) => cycleFinding(paths, model)),
    ...model.apps.flatMap((app) => depthFindings(app, graph, model)),
    ...model.apps.flatMap((app) => unsupportedImportFindings(app, model, reporting)),
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
    (link) => targetFailure(link, untrusted, reporting),
    (link, failure) =>
      failure === "outside" ? outsideFinding(link, model) : missingFinding(link, model),
    model,
  );
}

/**
 * Which failure a link is, without building the finding that would describe it.
 *
 * An out-of-bounds reference is reported whether or not it resolved — see {@link outsideFinding} —
 * so an in-bounds link that resolved is the only one with nothing to say.
 */
function targetFailure(
  link: ObservedLink,
  untrusted: ReadonlySet<string>,
  reporting: LinkReporting,
): FailureKind | undefined {
  if (untrusted.has(link.sourcePath) && !isWithin(link.targetPath, reporting.roots)) {
    return "outside";
  }
  return link.valid ? undefined : "missing";
}

function missingFinding(link: ObservedLink, model: WorkspaceModel): DetectedFinding {
  return {
    details: `Create ${displayInstructionPath(link.targetPath, model)}, correct the reference in ${displayInstructionPath(link.sourcePath, model)}, or remove the reference.`,
    id: structuralFindingId("missing", [link.sourcePath, link.targetPath, link.kind]),
    locations: [{ path: link.sourcePath }],
    message: `${displayInstructionPath(link.sourcePath, model)} links to missing file ${displayInstructionPath(link.targetPath, model)}.`,
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
function outsideFinding(link: ObservedLink, model: WorkspaceModel): DetectedFinding {
  return {
    details:
      "Aura only resolves references that stay inside the project or the directories instruction files live in. Point the reference inside the project, or remove it.",
    id: structuralFindingId("outside", [link.sourcePath, link.targetPath, link.kind]),
    locations: [{ path: link.sourcePath }],
    message: `${displayInstructionPath(link.sourcePath, model)} references ${displayInstructionPath(link.targetPath, model)}, which is outside the project and instruction directories.`,
    metadata: {
      failure: "outside",
      sourcePath: link.sourcePath,
      targetPath: link.targetPath,
    },
    severity: "info",
  };
}

function cycleFinding(paths: readonly string[], model: WorkspaceModel): DetectedFinding {
  const uniquePaths = paths.slice(0, -1);
  return {
    details: `Cycle: ${describeChain(paths, model)}. Remove or redirect at least one reference.`,
    id: structuralFindingId("cycle", uniquePaths),
    locations: uniquePaths.slice(0, MAX_REPORTED_PATHS).map((path) => ({ path })),
    message: `Instruction imports form a cycle across ${String(uniquePaths.length)} ${pluralize(uniquePaths.length, "file")}.`,
    // The closing repeat of the first path is what makes the chain readable as a cycle, so the
    // bound is applied to the whole walk rather than to the distinct files inside it.
    metadata: { failure: "cycle", paths: paths.slice(0, MAX_REPORTED_PATHS) },
  };
}

function depthFindings(
  app: AppModel,
  graph: InstructionGraph,
  model: WorkspaceModel,
): readonly DetectedFinding[] {
  const limit = instructionCapabilities(app).importDepthLimit;
  if (limit === undefined) {
    return [];
  }
  const roots = app.instructionFiles.map((document) => document.path);
  return findDepthOverflows(graph, roots, limit).map((overflow) => ({
    details: `Chain: ${describeChain(overflow.paths, model)}. Flatten or shorten it to at most ${String(limit)} import hops.`,
    id: structuralFindingId("depth", [app.adapterId, overflow.rootPath]),
    locations: [{ path: overflow.rootPath }],
    message: `${app.displayName} instruction imports exceed its ${String(limit)}-hop limit from ${displayInstructionPath(overflow.rootPath, model)}.`,
    metadata: {
      appId: app.adapterId,
      failure: "depth",
      limit,
      paths: overflow.paths.slice(0, MAX_REPORTED_PATHS),
      rootPath: overflow.rootPath,
    },
  }));
}

function unsupportedImportFindings(
  app: AppModel,
  model: WorkspaceModel,
  reporting: LinkReporting,
): readonly DetectedFinding[] {
  if (instructionCapabilities(app).importStyle !== "none") {
    return [];
  }
  const links = observedLinks(app.instructionFiles).filter(
    (link) => link.kind === "import" && reporting.inertImports.has(link.sourcePath),
  );
  return perSource(
    links,
    () => "unsupported",
    (link) => ({
      details: `${app.displayName} does not load import directives from this file. Remove the directive or use the application's native instruction mechanism.`,
      id: structuralFindingId("unsupported", [app.adapterId, link.sourcePath, link.targetPath]),
      locations: [{ path: link.sourcePath }],
      message: `${displayInstructionPath(link.sourcePath, model)} contains an import that ${app.displayName} does not support.`,
      metadata: {
        appId: app.adapterId,
        failure: "unsupported",
        sourcePath: link.sourcePath,
        targetPath: link.targetPath,
      },
      severity: "warn",
    }),
    model,
    // Every application that cannot follow imports reports the same source, so the summaries
    // standing in for their capped findings need the application to tell them apart.
    { overflowScope: [app.adapterId] },
  );
}

function describeChain(paths: readonly string[], model: WorkspaceModel): string {
  const shown = paths
    .slice(0, MAX_REPORTED_PATHS)
    .map((path) => displayInstructionPath(path, model))
    .join(" -> ");
  return paths.length > MAX_REPORTED_PATHS ? `${shown} -> …` : shown;
}
