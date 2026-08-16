import { dirname, resolve, sep } from "node:path";

import { isConfigRecord, parseConfigObject, type AdapterSourceFile } from "@tryaura/aura-sdk";
import { parse } from "smol-toml";

import type { ProjectTrust } from "./contract.js";

/** Where the current project sits, from the narrowest directory outward. */
export interface TrustLookup {
  /** Directory Aura was invoked from. */
  readonly cwd: string;
  /** Repository root containing {@link TrustLookup.cwd}, when one was found. */
  readonly projectRoot?: string | undefined;
}

/** Guards against a cwd that is not actually inside the reported root. */
const MAX_ANCESTORS = 64;

/**
 * Reads the current project's trust marker from Codex's shared configuration.
 *
 * Codex keys `[projects."..."]` by the directory it was launched in, which is frequently a
 * subdirectory of the repository rather than its root. Looking only at the root would report a
 * project as untrusted whenever the developer started Codex from somewhere inside it, so every
 * directory from `cwd` up to and including the repository root is considered and the narrowest
 * recorded answer wins.
 */
export function parseProjectTrust(file: AdapterSourceFile, lookup: TrustLookup): ProjectTrust {
  const root = parseConfigObject(file.content, parse);
  const projects = root?.["projects"];
  if (!isConfigRecord(projects)) {
    return "unknown";
  }

  const entries = new Map(
    Object.entries(projects).map(([key, value]) => [normalize(key), value] as const),
  );

  for (const directory of candidateDirectories(lookup)) {
    const project = entries.get(directory);
    if (!isConfigRecord(project)) {
      continue;
    }
    const trust = project["trust_level"];
    if (trust === "trusted" || trust === "untrusted") {
      return trust;
    }
  }

  return "unknown";
}

function* candidateDirectories(lookup: TrustLookup): Generator<string> {
  let current = normalize(lookup.cwd);

  // Without a repository root there is no bound to walk to, and every ancestor of the working
  // directory is a different project as far as Codex is concerned, so only cwd is considered.
  if (lookup.projectRoot === undefined) {
    yield current;
    return;
  }

  const stop = normalize(lookup.projectRoot);
  for (let depth = 0; depth < MAX_ANCESTORS && isWithin(current, stop); depth += 1) {
    yield current;
    if (current === stop) {
      return;
    }

    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Collapses separators and trailing slashes so a config key and a scanned path compare equal. */
function normalize(directory: string): string {
  return resolve(directory);
}
