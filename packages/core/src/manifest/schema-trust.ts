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
  const paths = new Set<string>();
  return {
    trustedRepoPresets: Object.freeze(
      value.map((candidate, index) => {
        const path = `$.trustedRepoPresets[${String(index)}]`;
        const entry = requiredObject(candidate, path);
        const presetPath = requiredString(entry, "path", path);
        if (presetPath.length === 0 || presetPath.length > MAX_TRUSTED_PATH_LENGTH) {
          throw invalid(
            `${path}.path`,
            `must be a non-empty path of at most ${String(MAX_TRUSTED_PATH_LENGTH)} characters`,
          );
        }
        if (paths.has(presetPath)) {
          throw invalid(`${path}.path`, "must not duplicate another trusted preset path");
        }
        paths.add(presetPath);
        const hash = requiredString(entry, "hash", path);
        if (!SHA256_PATTERN.test(hash)) {
          throw invalid(`${path}.hash`, "must be a lowercase SHA-256 hash");
        }
        return Object.freeze({ ...entry, hash, path: presetPath });
      }),
    ),
  };
}
