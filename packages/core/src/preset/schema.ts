import type { AuraTeamPreset } from "@tryaura/aura-sdk";
import { jsonPropertyPath } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { collectChecks, isChecks } from "./schema-checks.js";
import {
  collectIds,
  CONTENT_ID_PATTERN,
  firstProblem,
  MAX_JSON_DEPTH,
  MCP_CATALOG_ID_PATTERN,
} from "./schema-common.js";
import { collectProvides } from "./schema-provides.js";
import { collectAllowedSources, collectDirectories, collectSkills } from "./schema-sources.js";

/**
 * Why a parsed preset document cannot be used, or the preset when it can.
 *
 * Problems name the JSON path and the rule, never the offending value: a preset sits beside files
 * that hold credentials, and a validator that echoes input turns a paste mistake into a leak.
 */
export type TeamPresetParseResult =
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "preset"; readonly preset: AuraTeamPreset };

/** How the validator treats fields only one preset origin may carry. */
export interface TeamPresetValidationOptions {
  /**
   * Whether `provides` — repository-authored MCP definitions — is acceptable.
   *
   * Only the repository preset reader passes true. A preset that arrives by selection or
   * download must not be able to smuggle in content the repository trust prompt never showed.
   */
  readonly allowProvides?: boolean | undefined;
}

/** Validates and freezes one parsed JSON document as a data-only team preset. */
export function validateTeamPreset(
  value: unknown,
  options: TeamPresetValidationOptions = {},
): TeamPresetParseResult {
  if (!isRecord(value)) {
    return invalid("$: must be an object");
  }
  const problemBeforeFields = envelopeProblem(value, options);
  if (problemBeforeFields !== undefined) {
    return invalid(problemBeforeFields);
  }

  const name = value["name"];
  const checks = collectChecks(value["checks"]);
  const allowed = collectAllowedSources(value["allowedSkillSources"]);
  const directories = collectDirectories(value["skillDirectories"]);
  const requiredMcpServers = collectIds(
    value["requiredMcpServers"],
    "$.requiredMcpServers",
    MCP_CATALOG_ID_PATTERN,
  );
  const snippets = collectIds(value["snippets"], "$.snippets", CONTENT_ID_PATTERN);
  const skills = collectSkills(value["skills"]);
  const provides = collectProvides(value["provides"]);
  const problem = firstProblem([
    checks,
    allowed,
    directories,
    requiredMcpServers,
    snippets,
    skills,
    provides,
  ]);
  if (problem !== undefined) {
    return invalid(problem);
  }

  return {
    kind: "preset",
    preset: Object.freeze({
      ...(Array.isArray(allowed) ? { allowedSkillSources: allowed } : {}),
      ...(isChecks(checks) ? { checks } : {}),
      ...(typeof provides === "object" ? { provides } : {}),
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

/** Checks the document envelope — depth, version, origin gate, name — before any field walks. */
function envelopeProblem(
  value: Record<string, unknown>,
  options: TeamPresetValidationOptions,
): string | undefined {
  const depthProblem = documentDepthProblem(value, "$", 0);
  if (depthProblem !== undefined) {
    return depthProblem;
  }
  if (value["schemaVersion"] !== 1) {
    return "$.schemaVersion: must be 1";
  }
  if (options.allowProvides !== true && value["provides"] !== undefined) {
    return "$.provides: only the repository preset may provide content";
  }
  const name = value["name"];
  if (
    name !== undefined &&
    (typeof name !== "string" || name.trim().length === 0 || name.length > 128)
  ) {
    return "$.name: must be a non-empty string of at most 128 characters";
  }
  return undefined;
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
