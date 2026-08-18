import type { SkillListing } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { MAX_DIRECTORY_INDEX_ENTRIES } from "./limits.js";
import { skillIdProblem } from "./path-guards.js";

/**
 * The parsed `index.json` of a skill directory.
 *
 * A malformed entry drops that entry with a problem naming its position, never the whole index:
 * one bad listing must not hide a directory. Problems never echo server bytes — they travel into
 * diagnostics.
 */
export interface DirectoryIndex {
  readonly listings: readonly SkillListing[];
  readonly problems: readonly string[];
}

/** Parses a directory's `index.json` body: a JSON array of listing objects. */
export function parseDirectoryIndex(body: string): DirectoryIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { listings: [], problems: ["is not valid JSON"] };
  }
  if (!Array.isArray(parsed)) {
    return { listings: [], problems: ["is not a JSON array of skill listings"] };
  }

  const listings: SkillListing[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  if (parsed.length > MAX_DIRECTORY_INDEX_ENTRIES) {
    problems.push(
      `advertises ${String(parsed.length)} entries; only the first ` +
        `${String(MAX_DIRECTORY_INDEX_ENTRIES)} are read`,
    );
  }

  for (const [index, entry] of parsed.slice(0, MAX_DIRECTORY_INDEX_ENTRIES).entries()) {
    const listing = parseListing(entry, seen);
    if (typeof listing === "string") {
      problems.push(`entry ${String(index)} ${listing}`);
      continue;
    }
    seen.add(listing.id);
    listings.push(listing);
  }

  return { listings: Object.freeze(listings), problems: Object.freeze(problems) };
}

/** One frozen listing, or the problem that drops this entry. */
function parseListing(entry: unknown, seen: ReadonlySet<string>): SkillListing | string {
  if (!isRecord(entry)) {
    return "is not an object";
  }
  const description = entry["description"];
  const id = entry["id"];
  const name = entry["name"];
  const version = entry["version"];
  if (
    typeof description !== "string" ||
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof version !== "string"
  ) {
    return 'is missing one of the string fields "description", "id", "name", "version"';
  }
  const idProblem = skillIdProblem(id);
  if (idProblem !== undefined) {
    return `has an ID that ${idProblem}`;
  }
  if (seen.has(id)) {
    return "repeats an earlier ID";
  }
  return Object.freeze({ description, id, name, version });
}
