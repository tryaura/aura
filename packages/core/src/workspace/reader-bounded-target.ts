import type { Stats } from "node:fs";
import { readlink, stat } from "node:fs/promises";

import { isAbsence, toProblem } from "./reader-errors.js";
import { compatibleLstat } from "./reader-filesystem.js";
import type { BoundedPathRead } from "./reader.js";

/** What a bounded read found at a path before deciding whether it may touch it. */
export interface InspectedTarget {
  readonly kind: "target";
  readonly pathKind: "directory" | "file" | "symlink";
  /** Stats of the object the path leads to, following one symbolic link. */
  readonly stats: Stats;
  readonly symlinkTarget?: string | undefined;
}

/** An outcome settled during inspection, before any boundary question could arise. */
export interface InspectionResult {
  readonly kind: "result";
  readonly result: BoundedPathRead;
}

export function inspectionResult(value: BoundedPathRead): InspectionResult {
  return { kind: "result", result: value };
}

/**
 * Classifies a path without opening it, so absence and unreadable links settle before anything else.
 *
 * Nothing decided here can be trusted to still hold afterwards — the point is only to route the
 * path to the right reader and to answer the outcomes that need no boundary at all. Containment
 * and identity are settled later, against the object that is actually read.
 */
export async function inspectTarget(path: string): Promise<InspectedTarget | InspectionResult> {
  let entryStats: Stats;
  try {
    entryStats = await compatibleLstat(path);
  } catch (error) {
    return inspectionResult({
      contents: isAbsence(error)
        ? { exists: false, isDirectory: false }
        : { exists: false, isDirectory: false, problem: toProblem(error) },
      kind: "read",
    });
  }

  const pathKind = entryStats.isSymbolicLink()
    ? "symlink"
    : entryStats.isDirectory()
      ? "directory"
      : "file";
  if (pathKind !== "symlink") {
    return { kind: "target", pathKind, stats: entryStats };
  }
  return inspectSymlinkTarget(path);
}

async function inspectSymlinkTarget(path: string): Promise<InspectedTarget | InspectionResult> {
  let symlinkTarget: string;
  try {
    symlinkTarget = await readlink(path);
  } catch (error) {
    return inspectionResult({
      contents: {
        exists: true,
        isDirectory: false,
        pathKind: "symlink",
        problem: toProblem(error),
      },
      kind: "read",
    });
  }

  try {
    return {
      kind: "target",
      pathKind: "symlink",
      stats: await stat(path),
      symlinkTarget,
    };
  } catch (error) {
    return inspectionResult({
      contents: isAbsence(error)
        ? { exists: true, isDirectory: false, pathKind: "symlink", symlinkTarget }
        : {
            exists: true,
            isDirectory: false,
            pathKind: "symlink",
            problem: toProblem(error),
            symlinkTarget,
          },
      kind: "read",
    });
  }
}
