import type { SkillListing } from "@tryaura/aura-sdk";

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

export type AgenticCatalogOutcome =
  | {
      readonly entries: readonly AgenticCatalogEntry[];
      readonly kind: "catalog";
      readonly problems: readonly string[];
    }
  | { readonly kind: "failure"; readonly reason: string };

export interface GitHubLocation {
  readonly directory: string;
  readonly owner: string;
  readonly ref: string;
  readonly repository: string;
}
