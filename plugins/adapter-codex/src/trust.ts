import { resolve } from "node:path";

import { isConfigRecord, parseConfigObject, type AdapterSourceFile } from "@tryaura/aura-sdk";
import { parse } from "smol-toml";

import type { ProjectTrust } from "./contract.js";

/** The two repository identities Codex consults for project trust. */
export interface TrustLookup {
  /** Directory Codex was launched in. */
  readonly cwd: string;
  /** Primary Git checkout, which differs from the current root inside a linked worktree. */
  readonly gitMainWorktreeRoot?: string | undefined;
}

/**
 * Reads the current project's trust marker from Codex's shared configuration.
 *
 * Codex first checks the exact directory it was launched in, then the primary Git checkout. The
 * second identity matters for linked worktrees: Codex resolves their `.git` pointer back to the
 * main checkout, so trusting that checkout covers every associated worktree unless an exact cwd
 * entry overrides it.
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

  for (const directory of trustDirectories(lookup)) {
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

function trustDirectories(lookup: TrustLookup): readonly string[] {
  const cwd = normalize(lookup.cwd);
  if (lookup.gitMainWorktreeRoot === undefined) {
    return [cwd];
  }

  const mainWorktreeRoot = normalize(lookup.gitMainWorktreeRoot);
  return cwd === mainWorktreeRoot ? [cwd] : [cwd, mainWorktreeRoot];
}

/** Collapses separators and trailing slashes so a config key and a scanned path compare equal. */
function normalize(directory: string): string {
  return resolve(directory);
}
