import { dirname, join, resolve } from "node:path";

import type { FileOperation, ResolvedSkillPack, SharedSkillEntry } from "@tryaura/aura-sdk";
import { gt, valid } from "semver";

/**
 * How an available source revision relates to the one recorded in the manifest.
 *
 * `"diverged"` is deliberately distinct from `"current"`: a downgrade, or a pair of versions semver
 * cannot order, still means the installed content and the source disagree. Collapsing that into
 * `"current"` would let setup write the older source content over a newer recorded revision;
 * collapsing it into `"update"` would present a rollback as an upgrade. Naming it lets every caller
 * hold the recorded revision *and* say so, which is the difference between a safe default and a
 * silent one.
 */
export type ManagedContentRevisionStatus = "current" | "diverged" | "update";

/** Whether a source revision is a reviewable update, a divergence, or already installed. */
export function managedContentRevisionStatus(
  installedVersion: string,
  installedHash: string,
  availableVersion: string,
  availableHash: string,
): ManagedContentRevisionStatus {
  if (installedVersion === availableVersion) {
    return installedHash === availableHash ? "current" : "update";
  }
  if (valid(installedVersion) === null || valid(availableVersion) === null) {
    return "diverged";
  }
  return gt(availableVersion, installedVersion) ? "update" : "diverged";
}

/** Replaces one shared skill tree using the same operation ordering in setup and guided checks. */
export function planSharedSkillTreeUpdate(
  root: string,
  existingEntries: readonly SharedSkillEntry[],
  desired: ResolvedSkillPack,
): readonly FileOperation[] {
  const desiredPaths = new Set(desired.files.map((file) => resolve(root, ...file.path.split("/"))));
  const desiredParents = ancestorDirectories(desiredPaths);
  const stale = existingEntries.filter((entry) => {
    const path = resolve(entry.path);
    return !desiredPaths.has(path) && (entry.kind !== "directory" || !desiredParents.has(path));
  });
  return [
    ...[...stale]
      .sort((left, right) => right.path.length - left.path.length)
      .map((entry): FileOperation => ({ path: entry.path, type: "remove" })),
    ...desired.files.map((file): FileOperation => ({
      content: file.content,
      path: join(root, ...file.path.split("/")),
      type: "write",
    })),
  ];
}

/**
 * Every directory that contains at least one desired path.
 *
 * Precomputed once so the stale filter stays linear: comparing each existing directory against
 * every desired path pairwise re-normalized both sides on every comparison.
 */
function ancestorDirectories(paths: ReadonlySet<string>): ReadonlySet<string> {
  const parents = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    while (!parents.has(parent)) {
      parents.add(parent);
      const next = dirname(parent);
      if (next === parent) {
        break;
      }
      parent = next;
    }
  }
  return parents;
}
