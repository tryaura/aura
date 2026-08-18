import { Buffer } from "node:buffer";

import type { ResolvedSkillFile, SkillListing } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, MAX_SKILL_RESPONSE_BYTES } from "./limits.js";
import { portableSkillFilePathKey, skillFilePathProblem } from "./path-guards.js";

const SKILL_FILE = "SKILL.md";

/**
 * The parsed content response for one skill, or why the whole response is refused.
 *
 * Unlike the index, a pack is all-or-nothing: installing a skill with silently missing files would
 * change its meaning, so any guard failure refuses the pack. Problems never echo server bytes.
 */
export type DirectorySkillPack =
  | { readonly kind: "invalid"; readonly problem: string }
  | {
      readonly files: readonly ResolvedSkillFile[];
      readonly kind: "pack";
      readonly listing: SkillListing;
    };

/**
 * Parses a directory's `skills/<id>` body.
 *
 * Expected shape: `{ description, id, name, version, files: [{ path, content }] }`. An entry
 * without a string `content` — a symlink or binary reference — is skipped rather than followed,
 * matching the local walker's symlink policy.
 */
// fallow-ignore-next-line complexity -- every branch refuses one hostile response shape.
export function parseDirectorySkillPack(body: string, expectedId: string): DirectorySkillPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid", problem: "response is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { kind: "invalid", problem: "response is not a JSON object" };
  }

  const description = parsed["description"];
  const id = parsed["id"];
  const name = parsed["name"];
  const version = parsed["version"];
  if (
    typeof description !== "string" ||
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof version !== "string"
  ) {
    return {
      kind: "invalid",
      problem:
        'response is missing one of the string fields "description", "id", "name", "version"',
    };
  }
  if (id !== expectedId) {
    return { kind: "invalid", problem: "response describes a different skill ID than requested" };
  }
  if (!Array.isArray(parsed["files"])) {
    return { kind: "invalid", problem: 'response has no "files" array' };
  }

  const files = collectFiles(parsed["files"]);
  if (typeof files === "string") {
    return { kind: "invalid", problem: files };
  }
  if (!files.some((file) => file.path === SKILL_FILE)) {
    return { kind: "invalid", problem: `response does not contain a root ${SKILL_FILE}` };
  }

  return {
    files,
    kind: "pack",
    listing: Object.freeze({ description, id, name, version }),
  };
}

/** Every retained file, or the problem that refuses the pack. */
// fallow-ignore-next-line complexity -- every branch refuses one hostile file shape.
function collectFiles(entries: readonly unknown[]): readonly ResolvedSkillFile[] | string {
  const files: ResolvedSkillFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || typeof entry["path"] !== "string") {
      return `file ${String(index)} has no string "path"`;
    }
    const path = entry["path"];
    const content = entry["content"];
    if (typeof content !== "string") {
      // A symlink or binary reference: skipped, never followed.
      continue;
    }
    const pathProblem = skillFilePathProblem(path);
    if (pathProblem !== undefined) {
      return `file ${String(index)} path ${pathProblem}`;
    }
    const portablePath = portableSkillFilePathKey(path);
    if (seen.has(portablePath)) {
      return `file ${String(index)} repeats or aliases an earlier path`;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SKILL_FILE_BYTES) {
      return `file ${String(index)} is larger than the ${String(MAX_SKILL_FILE_BYTES)} byte limit`;
    }
    totalBytes += bytes;
    if (totalBytes > MAX_SKILL_RESPONSE_BYTES) {
      return `content is larger than the ${String(MAX_SKILL_RESPONSE_BYTES)} byte limit`;
    }
    if (files.length >= MAX_SKILL_FILES) {
      return `response carries more than ${String(MAX_SKILL_FILES)} files`;
    }
    seen.add(portablePath);
    files.push(Object.freeze({ content, path }));
  }

  return Object.freeze(files);
}
