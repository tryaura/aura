import type { AuraManifest, AuraTeamPreset, Environment } from "@tryaura/aura-sdk";

import { hashManagedSnippet } from "../managed-block/protocol.js";
import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import { createFileReader, type FileReader } from "../workspace/reader.js";
import { resolveTeamPresetPath } from "./protocol.js";
import { readTeamPreset } from "./read.js";

/** The repository preset file as read for this run, before any trust decision. */
export interface RepoPresetState {
  readonly diagnostics: readonly ScanDiagnostic[];
  /** Present only when the file was readable and valid. */
  readonly hash?: string | undefined;
  /** Absolute path of the repository preset file, whether or not it exists. */
  readonly path: string;
  readonly preset?: AuraTeamPreset | undefined;
  readonly status: "invalid" | "missing" | "ready";
}

/**
 * Hashes repository preset contents for the trust record.
 *
 * Uses the managed-snippet canonicalization so a checkout that rewrites line endings does not
 * invalidate a trust the user already granted to the same bytes-as-authored.
 */
export function hashRepoPreset(content: string): string {
  return hashManagedSnippet(content);
}

/** Reads and validates the repository preset below the invoking directory. */
export async function readRepoPreset(
  environment: Environment,
  reader: FileReader = createFileReader(),
): Promise<RepoPresetState> {
  const path = resolveTeamPresetPath(environment.cwd);
  const state = await readTeamPreset(environment.cwd, reader);
  if (state.status !== "ready" || state.preset === undefined || state.content === undefined) {
    return { diagnostics: state.diagnostics, path, status: state.status };
  }
  return {
    diagnostics: state.diagnostics,
    hash: hashRepoPreset(state.content),
    path,
    preset: state.preset,
    status: "ready",
  };
}

/** Whether the manifest records an acceptance of exactly these repository preset contents. */
export function isRepoPresetTrusted(
  manifest: AuraManifest | undefined,
  path: string,
  hash: string,
): boolean {
  return (manifest?.trustedRepoPresets ?? []).some(
    (entry) => entry.path === path && entry.hash === hash,
  );
}
