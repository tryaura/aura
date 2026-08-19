import type { AuraManifestTrustedRepoPreset, JsonValue } from "@tryaura/aura-sdk";

import { invalid, requiredObject, requiredString, SHA256_PATTERN } from "./schema-values.js";

/** Room for many working checkouts without turning the trust list into unbounded storage. */
export const MAX_TRUSTED_REPO_PRESETS = 64;
const MAX_TRUSTED_PATH_LENGTH = 1024;

/**
 * Reads `trustedRepoPresets`, the repository presets the user accepted during setup.
 *
 * Each entry binds an absolute preset path to a hash of the exact contents that were reviewed, so
 * a file edited after acceptance is untrusted again until someone looks at the new contents. Only
 * acceptances appear here: declining records nothing, and the next interactive setup asks again.
 *
 * `mainWorktreePath` names the same file in the repository's primary Git checkout and carries no
 * uniqueness of its own: every worktree of one repository shares it, so a repository accumulates
 * one entry per distinct set of contents its user accepted rather than one per working directory.
 */
export function optionalTrustedRepoPresets(value: JsonValue | undefined): {
  readonly trustedRepoPresets?: readonly AuraManifestTrustedRepoPreset[];
} {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    throw invalid("$.trustedRepoPresets", "must be an array");
  }
  if (value.length > MAX_TRUSTED_REPO_PRESETS) {
    throw invalid(
      "$.trustedRepoPresets",
      `must contain at most ${String(MAX_TRUSTED_REPO_PRESETS)} entries`,
    );
  }
  const records = new Set<string>();
  return {
    trustedRepoPresets: Object.freeze(
      value.map((candidate, index) => {
        const path = `$.trustedRepoPresets[${String(index)}]`;
        const entry = requiredObject(candidate, path);
        const presetPath = trustedPath(requiredString(entry, "path", path), `${path}.path`);
        const hash = requiredString(entry, "hash", path);
        if (!SHA256_PATTERN.test(hash)) {
          throw invalid(`${path}.hash`, "must be a lowercase SHA-256 hash");
        }
        const record = `${presetPath}\0${hash}`;
        if (records.has(record)) {
          throw invalid(`${path}.hash`, "must not duplicate another trusted preset path and hash");
        }
        records.add(record);
        const mainWorktree = entry["mainWorktreePath"];
        if (mainWorktree === undefined) {
          return Object.freeze({ ...entry, hash, path: presetPath });
        }
        if (typeof mainWorktree !== "string") {
          throw invalid(`${path}.mainWorktreePath`, "must be a string");
        }
        return Object.freeze({
          ...entry,
          hash,
          mainWorktreePath: trustedPath(mainWorktree, `${path}.mainWorktreePath`),
          path: presetPath,
        });
      }),
    ),
  };
}

function trustedPath(value: string, jsonPath: string): string {
  if (value.length === 0 || value.length > MAX_TRUSTED_PATH_LENGTH) {
    throw invalid(
      jsonPath,
      `must be a non-empty path of at most ${String(MAX_TRUSTED_PATH_LENGTH)} characters`,
    );
  }
  return value;
}
