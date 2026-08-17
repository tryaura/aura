import { resolve } from "node:path";

import type { InstructionDocument } from "@tryaura/aura-sdk";

import { compareCodePoints } from "../ordering.js";

export interface InstructionGraph {
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

export interface BuildInstructionGraphOptions {
  /** Source documents whose import edges should be absent while preserving their other links. */
  readonly excludedImportSources?: ReadonlySet<string> | undefined;
}

export interface ReachableInstructionOptions {
  /**
   * Paths the walk neither returns nor passes through.
   *
   * Excluding a document excludes what only it reaches: a file an application loads on a condition
   * carries its own imports behind that same condition, so treating the document as absent is the
   * only reading that keeps everything behind it out too.
   */
  readonly excluded?: ReadonlySet<string> | undefined;
  /** Maximum number of edges followed from any root. Omit for an unbounded walk. */
  readonly maximumHops?: number | undefined;
}

const graphs = new WeakMap<readonly InstructionDocument[], InstructionGraph>();

/**
 * {@link buildInstructionGraph}, built once per document list.
 *
 * Every check receives the same `WorkspaceModel`, so the checks that walk instruction links all
 * ask for the same graph over the same array within one run. Keying on that array keeps the build
 * to once per run without any check having to know another one exists.
 */
export function instructionGraphFor(documents: readonly InstructionDocument[]): InstructionGraph {
  const cached = graphs.get(documents);
  if (cached !== undefined) {
    return cached;
  }
  const graph = buildInstructionGraph(documents);
  graphs.set(documents, graph);
  return graph;
}

/** Builds a deterministic graph from valid links whose targets are also modeled documents. */
export function buildInstructionGraph(
  documents: readonly InstructionDocument[],
  options: BuildInstructionGraphOptions = {},
): InstructionGraph {
  const documentPaths = new Set(documents.map((document) => resolve(document.path)));
  const excludedImportSources = new Set(
    [...(options.excludedImportSources ?? [])].map((path) => resolve(path)),
  );
  const mutable = new Map<string, Set<string>>();
  for (const path of documentPaths) {
    mutable.set(path, new Set());
  }
  for (const document of documents) {
    addDocumentEdges(document, documentPaths, mutable, excludedImportSources);
  }

  const edges = new Map<string, readonly string[]>();
  for (const [path, targets] of [...mutable.entries()].sort(([left], [right]) =>
    compareCodePoints(left, right),
  )) {
    edges.set(path, [...targets].sort(compareCodePoints));
  }
  return Object.freeze({ edges });
}

function addDocumentEdges(
  document: InstructionDocument,
  documentPaths: ReadonlySet<string>,
  mutable: Map<string, Set<string>>,
  excludedImportSources: ReadonlySet<string>,
): void {
  const sourcePath = resolve(document.path);
  const targets = mutable.get(sourcePath);
  if (targets === undefined) {
    return;
  }
  const importsExcluded = excludedImportSources.has(sourcePath);
  for (const link of document.links) {
    if (link.kind === "import" && importsExcluded) {
      continue;
    }
    const targetPath = resolve(link.targetPath);
    if (link.valid && documentPaths.has(targetPath)) {
      targets.add(targetPath);
    }
  }
}

/** Returns every modeled path reachable from the roots, once, without using the call stack. */
export function reachableInstructionPaths(
  graph: InstructionGraph,
  roots: readonly string[],
  options: ReachableInstructionOptions = {},
): readonly string[] {
  const maximumHops = options.maximumHops ?? Number.POSITIVE_INFINITY;
  const excluded = options.excluded ?? new Set<string>();
  const queued = [...new Set(roots.map((path) => resolve(path)))]
    .filter((path) => graph.edges.has(path) && !excluded.has(path))
    .sort(compareCodePoints)
    .map((path) => ({ hops: 0, path }));
  const seen = new Set<string>();

  for (let index = 0; index < queued.length; index += 1) {
    const current = queued[index];
    if (current === undefined || seen.has(current.path)) {
      continue;
    }
    seen.add(current.path);
    if (current.hops >= maximumHops) {
      continue;
    }
    for (const target of graph.edges.get(current.path) ?? []) {
      if (!seen.has(target) && !excluded.has(target)) {
        queued.push({ hops: current.hops + 1, path: target });
      }
    }
  }

  return [...seen].sort(compareCodePoints);
}

/** One node on an explicit walk stack, standing in for a call frame the walks refuse to use. */
export interface GraphFrame {
  nextEdge: number;
  readonly path: string;
}

/** Finds directed cycles without using the JavaScript call stack. */
export function findInstructionCycles(graph: InstructionGraph): readonly (readonly string[])[] {
  const state = new Map<string, "visiting" | "visited">();
  const cycles = new Map<string, readonly string[]>();

  for (const root of graph.edges.keys()) {
    if (!state.has(root)) {
      findCyclesFromRoot(graph, root, state, cycles);
    }
  }

  return [...cycles.values()].sort((left, right) =>
    compareCodePoints(cycleKey(left), cycleKey(right)),
  );
}

function findCyclesFromRoot(
  graph: InstructionGraph,
  root: string,
  state: Map<string, "visiting" | "visited">,
  cycles: Map<string, readonly string[]>,
): void {
  const path: string[] = [root];
  const indexes = new Map<string, number>([[root, 0]]);
  const frames: GraphFrame[] = [{ nextEdge: 0, path: root }];
  state.set(root, "visiting");

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) {
      return;
    }
    const target = (graph.edges.get(frame.path) ?? [])[frame.nextEdge];
    if (target === undefined) {
      finishFrame(frame, frames, path, indexes, state);
    } else {
      frame.nextEdge += 1;
      visitTarget(target, frames, path, indexes, state, cycles);
    }
  }
}

function finishFrame(
  frame: GraphFrame,
  frames: GraphFrame[],
  path: string[],
  indexes: Map<string, number>,
  state: Map<string, "visiting" | "visited">,
): void {
  frames.pop();
  path.pop();
  indexes.delete(frame.path);
  state.set(frame.path, "visited");
}

function visitTarget(
  target: string,
  frames: GraphFrame[],
  path: string[],
  indexes: Map<string, number>,
  state: Map<string, "visiting" | "visited">,
  cycles: Map<string, readonly string[]>,
): void {
  const targetState = state.get(target);
  if (targetState === undefined) {
    indexes.set(target, path.length);
    path.push(target);
    frames.push({ nextEdge: 0, path: target });
    state.set(target, "visiting");
    return;
  }
  if (targetState !== "visiting") {
    return;
  }
  const start = indexes.get(target);
  if (start === undefined) {
    return;
  }
  const cycle = canonicalCycle([...path.slice(start), target]);
  cycles.set(cycleKey(cycle), cycle);
}

function canonicalCycle(cycle: readonly string[]): readonly string[] {
  const paths = cycle.slice(0, -1);
  let best = [...paths];
  for (let index = 1; index < paths.length; index += 1) {
    const rotated = [...paths.slice(index), ...paths.slice(0, index)];
    if (compareCodePoints(rotated.join("\u0000"), best.join("\u0000")) < 0) {
      best = rotated;
    }
  }
  const first = best[0];
  return first === undefined ? [] : [...best, first];
}

function cycleKey(cycle: readonly string[]): string {
  return cycle.slice(0, -1).join("\u0000");
}
