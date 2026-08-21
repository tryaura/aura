import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { AdapterFileSpec, WorkspaceModel } from "@tryaura/aura-sdk";

import { comparablePath } from "./claims.js";

/**
 * A location a plan may mutate.
 *
 * `exact` roots are single files an adapter declared directly; nothing may be written beneath them.
 * Every other root is a directory whose strict descendants are writable — the directory itself is
 * not, so a plan cannot replace or remove the root it was granted.
 */
export interface AllowedRoot {
  readonly exact: boolean;
  readonly path: string;
}

/**
 * Determines where a plan may write.
 *
 * Roots are derived only from Aura's shared home directory and what detected adapters declared as
 * global-scope configuration, so the writable surface of the home directory is exactly the
 * applications Aura found rather than a hardcoded guess. A declared file contributes its own
 * directory — `~/.claude/CLAUDE.md` yields `~/.claude`, not `~` — which keeps an adapter that reads
 * something under a shared directory such as `~/.config/<app>` from opening `~/.config` wholesale.
 */
export function resolveAllowedRoots(model: WorkspaceModel): readonly AllowedRoot[] {
  const homeDir = resolve(model.homeDir);
  const roots = new Map<string, AllowedRoot>();
  const sharedDirectory = dirname(resolve(model.sharedInstructions.path));
  if (isStrictDescendant(homeDir, sharedDirectory)) {
    add(roots, { exact: false, path: sharedDirectory });
  }

  for (const root of deriveManagedHomeRoots(model, homeDir)) {
    add(roots, root);
  }

  return Object.freeze([...roots.values()]);
}

/**
 * The most specific root that permits `path`, or undefined when none does.
 *
 * A directory root wins over an exact one, and the deepest directory root wins over its ancestors,
 * so the ancestor walk starts as close to the path as the grants allow.
 */
export function matchRoot(
  path: string,
  roots: readonly AllowedRoot[],
  caseInsensitive: boolean,
): AllowedRoot | undefined {
  // Folded once here rather than per root, since every comparison below needs the same spelling.
  const candidate = comparablePath(resolve(path), caseInsensitive);
  const directoryRoot = roots
    .filter(
      (root) =>
        !root.exact && isStrictDescendant(comparablePath(root.path, caseInsensitive), candidate),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];

  if (directoryRoot !== undefined) {
    return directoryRoot;
  }

  return roots.find(
    (root) => root.exact && comparablePath(root.path, caseInsensitive) === candidate,
  );
}

/** Renders the allowed roots for an error message, so a rejection says where writes may go. */
export function describeRoots(roots: readonly AllowedRoot[]): string {
  return roots
    .map((root) => (root.exact ? root.path : `${root.path}${sep}`))
    .sort()
    .join(", ");
}

/**
 * Returns true when `candidate` sits strictly inside `root`.
 *
 * Both arguments must already be resolved, and folded to the same case convention. Doing it in the
 * caller keeps `matchRoot` from re-resolving the one path it is asked about once per root.
 */
function isStrictDescendant(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference.length > 0 &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function deriveManagedHomeRoots(model: WorkspaceModel, homeDir: string): readonly AllowedRoot[] {
  return model.apps.flatMap((app) =>
    app.sourceFiles.flatMap(({ spec }) => rootsForSpec(spec, homeDir)),
  );
}

/** What one declared path grants: a directory for a skills tree, a file and its directory otherwise. */
function rootsForSpec(spec: AdapterFileSpec, homeDir: string): readonly AllowedRoot[] {
  if (spec.scope !== "global" || !isAbsolute(spec.path)) {
    return [];
  }

  const path = resolve(spec.path);
  if (!isStrictDescendant(homeDir, path)) {
    return [];
  }
  if (spec.kind === "skills") {
    return [{ exact: false, path }];
  }

  const directory = dirname(path);
  return isStrictDescendant(homeDir, directory)
    ? [
        { exact: true, path },
        { exact: false, path: directory },
      ]
    : [{ exact: true, path }];
}

function add(roots: Map<string, AllowedRoot>, root: AllowedRoot): void {
  const existing = roots.get(root.path);
  // A directory grant subsumes an exact one for the same path.
  if (existing === undefined || (existing.exact && !root.exact)) {
    roots.set(root.path, root);
  }
}
