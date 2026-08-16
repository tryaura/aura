import { resolve } from "node:path";

import type { InstructionDocument } from "@tryaura/aura-sdk";

export interface InstructionGraph {
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

export interface DepthOverflow {
  readonly paths: readonly string[];
  readonly rootPath: string;
}

/** Builds a deterministic graph from valid links whose targets are also modeled documents. */
export function buildInstructionGraph(documents: readonly InstructionDocument[]): InstructionGraph {
  const documentPaths = new Set(documents.map((document) => resolve(document.path)));
  const mutable = new Map<string, Set<string>>();
  for (const path of documentPaths) {
    mutable.set(path, new Set());
  }
  for (const document of documents) {
    const sourcePath = resolve(document.path);
    const targets = mutable.get(sourcePath);
    if (targets === undefined) {
      continue;
    }
    for (const link of document.links) {
      const targetPath = resolve(link.targetPath);
      if (link.valid && documentPaths.has(targetPath)) {
        targets.add(targetPath);
      }
    }
  }

  const edges = new Map<string, readonly string[]>();
  for (const [path, targets] of [...mutable.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    edges.set(
      path,
      [...targets].sort((left, right) => left.localeCompare(right)),
    );
  }
  return Object.freeze({ edges });
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

  return [...cycles.values()].sort((left, right) => cycleKey(left).localeCompare(cycleKey(right)));
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

/** Returns one deterministic over-limit chain per modeled entry document. */
export function findDepthOverflows(
  graph: InstructionGraph,
  roots: readonly string[],
  maximumHops: number,
): readonly DepthOverflow[] {
  const overflows: DepthOverflow[] = [];
  const normalizedRoots = [...new Set(roots.map((path) => resolve(path)))].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const rootPath of normalizedRoots) {
    if (!graph.edges.has(rootPath)) {
      continue;
    }
    const paths = firstOverflow(graph, rootPath, maximumHops);
    if (paths !== undefined) {
      overflows.push({ paths, rootPath });
    }
  }
  return overflows;
}

interface GraphFrame {
  nextEdge: number;
  readonly path: string;
}

/** A {@link GraphFrame} carrying what {@link firstOverflow} needs to memoize the walk. */
interface OverflowFrame extends GraphFrame {
  /** Hops still available when this node was entered, which is what clearing it vouches for. */
  readonly budget: number;
  /** Whether anything under this node was skipped for already being on the path. */
  routeDependent: boolean;
}

/**
 * Walks one root, remembering how much budget each node has already been cleared for.
 *
 * Without that memory the walk enumerates every simple path within the limit, which is exponential
 * in the graph's fan-out — and the documents feeding it arrive with whatever repository the user
 * checked out, so a few dozen mutually-importing files are enough to stall the scan. A node
 * explored with `n` hops left and found clean is clean for any `n` or fewer, so re-entering it with
 * no more budget than last time can only retrace the same ground.
 *
 * A node is only recorded as clean when nothing under it was skipped for already being on the
 * path. Such a skip is a judgement about this route rather than about the node, and the same node
 * reached another way may well have that edge available — so the taint travels up to every
 * ancestor whose own result depended on it.
 */
function firstOverflow(
  graph: InstructionGraph,
  root: string,
  maximumHops: number,
): readonly string[] | undefined {
  const path: string[] = [root];
  const active = new Set(path);
  const frames: OverflowFrame[] = [
    { budget: maximumHops, nextEdge: 0, path: root, routeDependent: false },
  ];
  const cleared = new Map<string, number>();

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) {
      return undefined;
    }
    const targets = graph.edges.get(frame.path) ?? [];
    const target = targets[frame.nextEdge];
    if (target === undefined) {
      finishOverflowFrame(frame, frames, path, active, cleared);
      continue;
    }
    frame.nextEdge += 1;
    if (active.has(target)) {
      frame.routeDependent = true;
      continue;
    }
    if (path.length > maximumHops) {
      return [...path, target];
    }
    const budget = maximumHops - path.length;
    if ((cleared.get(target) ?? -1) >= budget) {
      continue;
    }
    path.push(target);
    active.add(target);
    frames.push({ budget, nextEdge: 0, path: target, routeDependent: false });
  }
  return undefined;
}

function finishOverflowFrame(
  frame: OverflowFrame,
  frames: OverflowFrame[],
  path: string[],
  active: Set<string>,
  cleared: Map<string, number>,
): void {
  frames.pop();
  active.delete(frame.path);
  path.pop();
  if (!frame.routeDependent) {
    cleared.set(frame.path, Math.max(cleared.get(frame.path) ?? -1, frame.budget));
    return;
  }
  const parent = frames[frames.length - 1];
  if (parent !== undefined) {
    parent.routeDependent = true;
  }
}

function canonicalCycle(cycle: readonly string[]): readonly string[] {
  const paths = cycle.slice(0, -1);
  let best = [...paths];
  for (let index = 1; index < paths.length; index += 1) {
    const rotated = [...paths.slice(index), ...paths.slice(0, index)];
    if (rotated.join("\u0000").localeCompare(best.join("\u0000")) < 0) {
      best = rotated;
    }
  }
  const first = best[0];
  return first === undefined ? [] : [...best, first];
}

function cycleKey(cycle: readonly string[]): string {
  return cycle.slice(0, -1).join("\u0000");
}
