import type { SkillListing } from "@tryaura/aura-sdk";

import type { DirectoryTruncation } from "./index-schema.js";

export const AGENTICSKILLS_DIAGNOSTIC_ID = "core/skill-directory";
export const GITHUB_API_HEADERS = Object.freeze({
  Accept: "application/vnd.github+json",
  "User-Agent": "tryaura-aura",
  "X-GitHub-Api-Version": "2022-11-28",
});

export interface AgenticCatalogEntry {
  readonly github: GitHubLocation;
  readonly listing: SkillListing;
}

/** One curated selection the catalog itself advertises; data, never a policy layer. */
export interface AgenticCollection {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly skillIds: readonly string[];
}

export type AgenticCatalogOutcome =
  | {
      /** Set when the body came from the on-disk cache: how old that copy is. */
      readonly cacheAgeMs?: number | undefined;
      readonly collections: readonly AgenticCollection[];
      readonly entries: readonly AgenticCatalogEntry[];
      readonly kind: "catalog";
      readonly problems: readonly string[];
      /** Whether the cached body served because the provider could not be reached. */
      readonly staleAfterFailure?: boolean | undefined;
      readonly truncation?: DirectoryTruncation | undefined;
    }
  | { readonly kind: "failure"; readonly reason: string };

export interface GitHubLocation {
  readonly directory: string;
  readonly owner: string;
  readonly ref: string;
  readonly repository: string;
}
