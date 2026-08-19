import type {
  AuraManifest,
  AuraManifestApp,
  AuraManifestOwnership,
  AuraManifestOverrides,
  AuraManifestSkill,
  AuraManifestSnippet,
  JsonObject,
  JsonValue,
  SkillSourceId,
} from "@tryaura/aura-sdk";

import { defineOwnProperty, jsonPropertyPath } from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { AURA_MANIFEST_SCHEMA_VERSION } from "./protocol.js";
import { optionalChecks, optionalPreset } from "./schema-checks.js";
import { mcpServers } from "./schema-mcp.js";
import { optionalTrustedRepoPresets } from "./schema-trust.js";
import {
  invalid,
  requiredBoolean,
  requiredObject,
  requiredString,
  SHA256_PATTERN,
  stringArray,
} from "./schema-values.js";

export { AuraManifestValidationError } from "./schema-values.js";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const MCP_CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_SOURCE_PATTERN = /^(?:directory|driver|plugin):[^\s:]+$/u;
const OVERRIDE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/u;

/** Room for several future override kinds without leaving the forward-compat window unbounded. */
const MAX_OVERRIDE_KEYS = 32;

/**
 * How deep the manifest may nest.
 *
 * The normalizing walk below is recursive, and `JSON.parse` is not: a few kilobytes of `[` parses
 * fine and then overflows the stack on the way back out. A `RangeError` is not one of the failures
 * a manifest can degrade into, so it would escape as an exception and take the whole scan with it.
 * Version 1 nests four levels; this leaves room for extension fields without leaving that open.
 */
const MAX_DEPTH = 100;

/** Validates and normalizes a runtime value into manifest v1 without dropping extension fields. */
export function validateAuraManifest(value: unknown): AuraManifest {
  const source = jsonObject(value, "$", "manifest must be an object");
  const version = source["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw invalid("$.schemaVersion", "must be an integer");
  }
  if (version !== AURA_MANIFEST_SCHEMA_VERSION) {
    throw new UnsupportedAuraManifestVersionError(version);
  }

  return Object.freeze({
    ...source,
    apps: apps(source["apps"]),
    ...optionalChecks(source["checks"]),
    ...optionalIdList(source["ignoredApps"], "$.ignoredApps", APP_ID_PATTERN, "ignoredApps"),
    mcpServers: mcpServers(source["mcpServers"]),
    ownership: ownership(source["ownership"]),
    ...optionalOverrides(source["overrides"]),
    ...optionalPreset(source["preset"]),
    schemaVersion: AURA_MANIFEST_SCHEMA_VERSION,
    skills: skills(source["skills"]),
    snippets: snippets(source["snippets"]),
    ...optionalTrustedRepoPresets(source["trustedRepoPresets"]),
  });
}

/**
 * Reads `overrides`, keeping the extension keys a newer Aura may have written.
 *
 * Passing unknown keys through matches how the top-level object is normalized, so a downgrade does
 * not quietly delete a newer build's decisions. Unlike the top level, though, this object is
 * rebuilt from scratch on every setup run, so an unbounded bag here would be rewritten verbatim
 * forever: the key count and spelling are bounded to keep the forward-compatibility window from
 * doubling as unbounded manifest storage.
 */
function optionalOverrides(value: JsonValue | undefined): {
  readonly overrides?: AuraManifestOverrides;
} {
  if (value === undefined) {
    return {};
  }
  const source = requiredObject(value, "$.overrides");
  const keys = Object.keys(source);
  if (keys.length > MAX_OVERRIDE_KEYS) {
    throw invalid("$.overrides", `must contain at most ${String(MAX_OVERRIDE_KEYS)} keys`);
  }
  for (const key of keys) {
    if (!OVERRIDE_KEY_PATTERN.test(key)) {
      throw invalid(`$.overrides.${key}`, "must be a camelCase override name");
    }
  }
  const required = optionalIdList(
    source["requiredMcpServers"],
    "$.overrides.requiredMcpServers",
    MCP_CATALOG_ID_PATTERN,
    "requiredMcpServers",
  );
  return { overrides: Object.freeze({ ...source, ...required }) };
}

function optionalIdList(
  value: JsonValue | undefined,
  path: string,
  pattern: RegExp,
  key: string,
): Readonly<Record<string, readonly string[]>> {
  if (value === undefined) {
    return {};
  }
  const ids = stringArray(value, path);
  if (ids.length > 256) {
    throw invalid(path, "must contain at most 256 ids");
  }
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (!pattern.test(id)) {
      throw invalid(`${path}[${String(index)}]`, "must be a valid id");
    }
    if (seen.has(id)) {
      throw invalid(`${path}[${String(index)}]`, "must not duplicate another id");
    }
    seen.add(id);
  }
  return { [key]: ids };
}

function skills(value: JsonValue | undefined): readonly AuraManifestSkill[] {
  if (!Array.isArray(value)) {
    throw invalid("$.skills", "must be an array");
  }

  const ids = new Set<string>();
  return Object.freeze(
    value.map((candidate, index) => {
      const path = `$.skills[${String(index)}]`;
      const skill = requiredObject(candidate, path);
      const id = requiredString(skill, "id", path);
      if (id.length > 64 || !SKILL_ID_PATTERN.test(id)) {
        throw invalid(`${path}.id`, "must be a kebab-case skill ID of at most 64 characters");
      }
      if (ids.has(id)) {
        throw invalid(`${path}.id`, "must not duplicate another selected skill ID");
      }
      ids.add(id);
      const source = requiredSkillSource(skill, path);
      const treeHash = requiredString(skill, "treeHash", path);
      if (!SHA256_PATTERN.test(treeHash)) {
        throw invalid(`${path}.treeHash`, "must be a lowercase SHA-256 hash");
      }
      return Object.freeze({
        ...skill,
        id,
        pinned: requiredBoolean(skill, "pinned", path),
        source,
        treeHash,
        version: requiredString(skill, "version", path),
      });
    }),
  );
}

function requiredSkillSource(value: JsonObject, path: string): SkillSourceId {
  const source = requiredString(value, "source", path);
  if (!SKILL_SOURCE_PATTERN.test(source)) {
    throw invalid(`${path}.source`, "must be a plugin:, directory:, or driver: source ID");
  }
  if (source.startsWith("plugin:")) {
    return `plugin:${source.slice("plugin:".length)}`;
  }
  if (source.startsWith("directory:")) {
    return `directory:${source.slice("directory:".length)}`;
  }
  return `driver:${source.slice("driver:".length)}`;
}

export class UnsupportedAuraManifestVersionError extends Error {
  readonly actualVersion: number;

  constructor(actualVersion: number) {
    super(`$.schemaVersion: version ${String(actualVersion)} is not supported`);
    this.name = "UnsupportedAuraManifestVersionError";
    this.actualVersion = actualVersion;
  }
}

function apps(value: JsonValue | undefined): Readonly<Record<string, AuraManifestApp>> {
  const source = requiredObject(value, "$.apps");
  const result: Record<string, AuraManifestApp> = {};
  for (const [id, candidate] of Object.entries(source)) {
    const path = jsonPropertyPath("$.apps", id);
    const app = requiredObject(candidate, path);
    defineOwnProperty(
      result,
      id,
      Object.freeze({ ...app, managed: requiredBoolean(app, "managed", path) }),
    );
  }
  return Object.freeze(result);
}

function snippets(value: JsonValue | undefined): readonly AuraManifestSnippet[] {
  if (!Array.isArray(value)) {
    throw invalid("$.snippets", "must be an array");
  }

  return Object.freeze(
    value.map((candidate, index) => {
      const path = `$.snippets[${String(index)}]`;
      const snippet = requiredObject(candidate, path);
      const hash = requiredString(snippet, "hash", path);
      if (!SHA256_PATTERN.test(hash)) {
        throw invalid(`${path}.hash`, "must be a lowercase SHA-256 hash");
      }
      return Object.freeze({
        ...snippet,
        hash,
        id: requiredString(snippet, "id", path),
        pinned: requiredBoolean(snippet, "pinned", path),
        version: requiredString(snippet, "version", path),
      });
    }),
  );
}

function ownership(value: JsonValue | undefined): Readonly<Record<string, AuraManifestOwnership>> {
  const source = requiredObject(value, "$.ownership");
  const result: Record<string, AuraManifestOwnership> = {};
  for (const [id, candidate] of Object.entries(source)) {
    const path = jsonPropertyPath("$.ownership", id);
    const entry = requiredObject(candidate, path);
    defineOwnProperty(
      result,
      id,
      Object.freeze({
        ...entry,
        files: stringArray(entry["files"], `${path}.files`),
        mcpServerNames: stringArray(entry["mcpServerNames"], `${path}.mcpServerNames`),
      }),
    );
  }
  return Object.freeze(result);
}

function jsonObject(value: unknown, path: string, message: string): JsonObject {
  if (!isRecord(value)) {
    throw invalid(path, message);
  }
  return freezeJsonObject(value, path, 0);
}

function freezeJsonObject(value: Record<string, unknown>, path: string, depth: number): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    defineOwnProperty(result, key, jsonValue(candidate, jsonPropertyPath(path, key), depth + 1));
  }
  return Object.freeze(result);
}

function jsonValue(value: unknown, path: string, depth: number): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (depth > MAX_DEPTH) {
    throw invalid(path, `is nested deeper than the ${String(MAX_DEPTH)} level limit`);
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((candidate, index) => jsonValue(candidate, `${path}[${index}]`, depth + 1)),
    );
  }
  if (isRecord(value)) {
    return freezeJsonObject(value, path, depth);
  }
  throw invalid(path, "must be a JSON value");
}
