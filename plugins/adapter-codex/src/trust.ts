import { resolve } from "node:path";

import { isConfigRecord, parseConfigObject, type AdapterSourceFile } from "@tryaura/aura-sdk";
import { parse } from "smol-toml";

import type { ProjectTrust } from "./contract.js";
import { projectDirectories, type ProjectLookup } from "./project-directories.js";

/** Where the current project sits, from the narrowest directory outward. */
export type TrustLookup = ProjectLookup;

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
  if (root === undefined) {
    // A file present but unparseable is not "no trust entry": Codex ignores the whole file, so
    // nothing can be concluded about trust, and the adapter's own problem already names the cause.
    // Content core could not read is a different story — that failure is reported upstream, and
    // this reader has simply seen nothing.
    return file.content === undefined ? "unknown" : "unreadable";
  }
  const projects = root["projects"];
  if (!isConfigRecord(projects)) {
    return "unknown";
  }

  const entries = new Map(
    Object.entries(projects).map(([key, value]) => [normalize(key), value] as const),
  );

  for (const directory of projectDirectories(lookup)) {
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

/** Collapses separators and trailing slashes so a config key and a scanned path compare equal. */
function normalize(directory: string): string {
  return resolve(directory);
}
