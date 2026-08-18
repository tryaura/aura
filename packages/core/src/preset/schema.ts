import type { AuraTeamPreset, DirectorySkillSource, SkillSourceId } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { directorySourceProblem } from "../skills/directory-config.js";

/** Same grammar the manifest accepts for skill provenance ids. */
const SKILL_SOURCE_ID_PATTERN = /^(?:directory|driver|plugin):[^\s:]+$/u;

const DIRECTORY_PREFIX = "directory:";

/**
 * Why a parsed preset document cannot be used, or the preset when it can.
 *
 * Problems name the JSON path and the rule, never the offending value: a preset sits beside files
 * that hold credentials, and a validator that echoes input turns a paste mistake into a leak.
 */
export type TeamPresetParseResult =
  | { readonly kind: "invalid"; readonly problem: string }
  | { readonly kind: "preset"; readonly preset: AuraTeamPreset };

/** Validates one parsed JSON document as the minimal team preset. */
export function validateTeamPreset(value: unknown): TeamPresetParseResult {
  if (!isRecord(value)) {
    return { kind: "invalid", problem: "$: must be an object" };
  }
  if (value["schemaVersion"] !== 1) {
    return { kind: "invalid", problem: "$.schemaVersion: must be 1" };
  }

  const allowed = collectAllowedSources(value["allowedSkillSources"]);
  if (typeof allowed === "string") {
    return { kind: "invalid", problem: allowed };
  }

  const directories = collectDirectories(value["skillDirectories"]);
  if (typeof directories === "string") {
    return { kind: "invalid", problem: directories };
  }

  return {
    kind: "preset",
    preset: Object.freeze({
      ...(allowed === undefined ? {} : { allowedSkillSources: allowed }),
      schemaVersion: 1,
      ...(directories === undefined ? {} : { skillDirectories: directories }),
    }),
  };
}

/** The parsed list, `undefined` when absent, or the problem string when malformed. */
function collectAllowedSources(value: unknown): readonly SkillSourceId[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "$.allowedSkillSources: must be an array of skill source ids";
  }

  const sources: SkillSourceId[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `$.allowedSkillSources[${String(index)}]`;
    if (typeof entry !== "string" || !SKILL_SOURCE_ID_PATTERN.test(entry)) {
      return `${path}: must be a skill source id such as "directory:agenticskills"`;
    }
    sources.push(toSourceId(entry));
  }
  return Object.freeze(sources);
}

/** The parsed list, `undefined` when absent, or the problem string when malformed. */
function collectDirectories(value: unknown): readonly DirectorySkillSource[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "$.skillDirectories: must be an array of directory definitions";
  }

  const directories: DirectorySkillSource[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = parseDirectory(entry, `$.skillDirectories[${String(index)}]`);
    if (typeof parsed === "string") {
      return parsed;
    }
    directories.push(parsed);
  }
  return Object.freeze(directories);
}

// fallow-ignore-next-line complexity -- every branch refuses one malformed preset field.
function parseDirectory(value: unknown, path: string): DirectorySkillSource | string {
  if (!isRecord(value)) {
    return `${path}: must be an object`;
  }

  const id = value["id"];
  const name = value["name"];
  const url = value["url"];
  const tokenEnv = value["tokenEnv"];
  if (typeof id !== "string" || !id.startsWith(DIRECTORY_PREFIX)) {
    return `${path}.id: must be a string starting with "directory:"`;
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return `${path}.name: must be a non-empty string`;
  }
  if (typeof url !== "string") {
    return `${path}.url: must be a string`;
  }
  if (tokenEnv !== undefined && typeof tokenEnv !== "string") {
    return `${path}.tokenEnv: must be a string environment variable name`;
  }

  const identifier = toDirectoryId(id);
  const source: DirectorySkillSource =
    tokenEnv === undefined
      ? { id: identifier, kind: "directory", name, url }
      : { id: identifier, kind: "private-directory", name, tokenEnv, url };
  const problem = directorySourceProblem(source);
  return problem === undefined ? source : `${path}: ${problem}`;
}

/** Re-stamps a validated id with its template-literal type without asserting. */
function toDirectoryId(id: string): `directory:${string}` {
  return `${DIRECTORY_PREFIX}${id.slice(DIRECTORY_PREFIX.length)}`;
}

/** Re-stamps a validated id with its template-literal type without asserting. */
function toSourceId(id: string): SkillSourceId {
  if (id.startsWith(DIRECTORY_PREFIX)) {
    return toDirectoryId(id);
  }
  if (id.startsWith("driver:")) {
    return `driver:${id.slice("driver:".length)}`;
  }
  return `plugin:${id.slice(id.indexOf(":") + 1)}`;
}
