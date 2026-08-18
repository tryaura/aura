import type { AuraTeamPreset } from "@tryaura/aura-sdk";
import { jsonPropertyPath } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { collectChecks, isChecks } from "./schema-checks.js";
import { collectIds, CONTENT_ID_PATTERN, firstProblem, MAX_JSON_DEPTH } from "./schema-common.js";
import { collectAllowedSources, collectDirectories, collectSkills } from "./schema-sources.js";

/** Why a parsed preset document cannot be used, or the preset when it can. */
export type TeamPresetParseResult =
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "preset"; readonly preset: AuraTeamPreset };

/** Validates and freezes one parsed JSON document as a data-only team preset. */
export function validateTeamPreset(value: unknown): TeamPresetParseResult {
  if (!isRecord(value)) {
    return invalid("$: must be an object");
  }
  const depthProblem = documentDepthProblem(value, "$", 0);
  if (depthProblem !== undefined) {
    return invalid(depthProblem);
  }
  if (value["schemaVersion"] !== 1) {
    return invalid("$.schemaVersion: must be 1");
  }

  const name = value["name"];
  if (
    name !== undefined &&
    (typeof name !== "string" || name.trim().length === 0 || name.length > 128)
  ) {
    return invalid("$.name: must be a non-empty string of at most 128 characters");
  }
  const checks = collectChecks(value["checks"]);
  const allowed = collectAllowedSources(value["allowedSkillSources"]);
  const directories = collectDirectories(value["skillDirectories"]);
  const requiredMcpServers = collectIds(
    value["requiredMcpServers"],
    "$.requiredMcpServers",
    CONTENT_ID_PATTERN,
  );
  const snippets = collectIds(value["snippets"], "$.snippets", CONTENT_ID_PATTERN);
  const skills = collectSkills(value["skills"]);
  const problem = firstProblem([
    checks,
    allowed,
    directories,
    requiredMcpServers,
    snippets,
    skills,
  ]);
  if (problem !== undefined) {
    return invalid(problem);
  }

  return {
    kind: "preset",
    preset: Object.freeze({
      ...(Array.isArray(allowed) ? { allowedSkillSources: allowed } : {}),
      ...(isChecks(checks) ? { checks } : {}),
      ...(Array.isArray(requiredMcpServers) ? { requiredMcpServers } : {}),
      ...(typeof name === "string" ? { name } : {}),
      schemaVersion: 1,
      ...(Array.isArray(directories) ? { skillDirectories: directories } : {}),
      ...(Array.isArray(skills) ? { skills } : {}),
      ...(Array.isArray(snippets) ? { snippets } : {}),
    }),
  };
}

function invalid(problem: string): TeamPresetParseResult {
  return { kind: "invalid", problem };
}

/**
 * Rejects a document nested past the limit before any field is read.
 *
 * The per-field collectors recurse, so the depth has to be known safe before they start rather
 * than discovered partway down. One pass over the parsed document is what buys that.
 */
function documentDepthProblem(value: unknown, path: string, depth: number): string | undefined {
  if (depth > MAX_JSON_DEPTH) {
    return `${path}: is nested deeper than the ${String(MAX_JSON_DEPTH)} level limit`;
  }
  if (Array.isArray(value)) {
    for (const [index, candidate] of value.entries()) {
      const problem = documentDepthProblem(candidate, `${path}[${String(index)}]`, depth + 1);
      if (problem !== undefined) {
        return problem;
      }
    }
  } else if (isRecord(value)) {
    for (const [key, candidate] of Object.entries(value)) {
      const problem = documentDepthProblem(candidate, jsonPropertyPath(path, key), depth + 1);
      if (problem !== undefined) {
        return problem;
      }
    }
  }
  return undefined;
}
