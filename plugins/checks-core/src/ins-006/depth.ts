import { resolve } from "node:path";

import { compareCodePoints } from "../ordering.js";
import type { GraphFrame, InstructionGraph } from "./graph.js";

export interface DepthOverflow {
  readonly paths: readonly string[];
  readonly rootPath: string;
}

/** Returns one deterministic over-limit chain per modeled entry document. */
export function findDepthOverflows(
  graph: InstructionGraph,
  roots: readonly string[],
  maximumHops: number,
): readonly DepthOverflow[] {
  const overflows: DepthOverflow[] = [];
  const normalizedRoots = [...new Set(roots.map((path) => resolve(path)))].sort(compareCodePoints);
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
