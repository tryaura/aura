import type {
  AuraPresetSkillSelection,
  DirectorySkillSource,
  SkillSourceId,
} from "@tryaura/aura-sdk";

import { directorySourceProblem } from "../skills/directory-config.js";
import { MAX_TEAM_PRESET_ALLOWED_SOURCES, MAX_TEAM_PRESET_DIRECTORIES } from "../skills/limits.js";
import { isRecord } from "../values.js";
import {
  DIRECTORY_PREFIX,
  MAX_SELECTIONS,
  SKILL_ID_PATTERN,
  SKILL_SOURCE_ID_PATTERN,
} from "./schema-common.js";

// fallow-ignore-next-line complexity -- validates every field and uniqueness rule for skill selections.
export function collectSkills(
  value: unknown,
): readonly AuraPresetSkillSelection[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "$.skills: must be an array of source-qualified skill selections";
  }
  if (value.length > MAX_SELECTIONS) {
    return `$.skills: must contain at most ${String(MAX_SELECTIONS)} selections`;
  }
  const result: AuraPresetSkillSelection[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `$.skills[${String(index)}]`;
    if (!isRecord(candidate)) {
      return `${path}: must be an object`;
    }
    const id = candidate["id"];
    const source = candidate["source"];
    if (typeof id !== "string" || !SKILL_ID_PATTERN.test(id)) {
      return `${path}.id: must be a kebab-case skill id`;
    }
    if (typeof source !== "string" || !SKILL_SOURCE_ID_PATTERN.test(source)) {
      return `${path}.source: must be a plugin:, directory:, driver:, or repo: source id`;
    }
    const identity = `${source}/${id}`;
    if (seen.has(identity)) {
      return `${path}: must not duplicate another skill selection`;
    }
    seen.add(identity);
    result.push(Object.freeze({ id, source: toSourceId(source) }));
  }
  return Object.freeze(result);
}

export function collectAllowedSources(
  value: unknown,
): readonly SkillSourceId[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "$.allowedSkillSources: must be an array of skill source ids";
  }
  if (value.length > MAX_TEAM_PRESET_ALLOWED_SOURCES) {
    return `$.allowedSkillSources: must contain at most ${String(MAX_TEAM_PRESET_ALLOWED_SOURCES)} source ids`;
  }
  const result: SkillSourceId[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `$.allowedSkillSources[${String(index)}]`;
    if (typeof candidate !== "string" || !SKILL_SOURCE_ID_PATTERN.test(candidate)) {
      return `${path}: must be a skill source id such as "directory:agenticskills"`;
    }
    if (seen.has(candidate)) {
      return `${path}: must not duplicate another source id`;
    }
    seen.add(candidate);
    result.push(toSourceId(candidate));
  }
  return Object.freeze(result);
}

export function collectDirectories(
  value: unknown,
): readonly DirectorySkillSource[] | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return "$.skillDirectories: must be an array of directory definitions";
  }
  if (value.length > MAX_TEAM_PRESET_DIRECTORIES) {
    return `$.skillDirectories: must contain at most ${String(MAX_TEAM_PRESET_DIRECTORIES)} directory definitions`;
  }
  const result: DirectorySkillSource[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `$.skillDirectories[${String(index)}]`;
    const parsed = parseDirectory(candidate, path);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (seen.has(parsed.id)) {
      return `${path}.id: must not duplicate another directory id`;
    }
    seen.add(parsed.id);
    result.push(parsed);
  }
  return Object.freeze(result);
}

// fallow-ignore-next-line complexity -- validates public and credential-referencing directory variants.
// fallow-ignore-next-line complexity -- validates public and credential-referencing directory variants.
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
  return problem === undefined ? Object.freeze(source) : `${path}: ${problem}`;
}

function toDirectoryId(id: string): `directory:${string}` {
  return `${DIRECTORY_PREFIX}${id.slice(DIRECTORY_PREFIX.length)}`;
}

function toSourceId(id: string): SkillSourceId {
  if (id.startsWith(DIRECTORY_PREFIX)) {
    return toDirectoryId(id);
  }
  if (id.startsWith("driver:")) {
    return `driver:${id.slice("driver:".length)}`;
  }
  if (id.startsWith("repo:")) {
    return `repo:${id.slice("repo:".length)}`;
  }
  return `plugin:${id.slice(id.indexOf(":") + 1)}`;
}
