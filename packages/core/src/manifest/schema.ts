import type {
  AuraManifest,
  AuraManifestApp,
  AuraManifestOwnership,
  AuraManifestSkill,
  AuraManifestSnippet,
  JsonObject,
  JsonValue,
  SkillSourceId,
} from "@tryaura/aura-sdk";

import { isRecord } from "../values.js";
import { AURA_MANIFEST_SCHEMA_VERSION } from "./protocol.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_SOURCE_PATTERN = /^(?:directory|driver|plugin):[^\s:]+$/u;

/**
 * How deep the manifest may nest.
 *
 * The normalizing walk below is recursive, and `JSON.parse` is not: a few kilobytes of `[` parses
 * fine and then overflows the stack on the way back out. A `RangeError` is not one of the failures
 * a manifest can degrade into, so it would escape as an exception and take the whole scan with it.
 * Version 1 nests four levels; this leaves room for extension fields without leaving that open.
 */
const MAX_DEPTH = 100;

export class AuraManifestValidationError extends Error {
  readonly jsonPath: string;

  constructor(jsonPath: string, message: string) {
    super(`${jsonPath}: ${message}`);
    this.name = "AuraManifestValidationError";
    this.jsonPath = jsonPath;
  }
}

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
    mcpServers: objectArray(source["mcpServers"], "$.mcpServers"),
    ownership: ownership(source["ownership"]),
    schemaVersion: AURA_MANIFEST_SCHEMA_VERSION,
    skills: skills(source["skills"]),
    snippets: snippets(source["snippets"]),
  });
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
    const path = propertyPath("$.apps", id);
    const app = requiredObject(candidate, path);
    define(result, id, Object.freeze({ ...app, managed: requiredBoolean(app, "managed", path) }));
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
    const path = propertyPath("$.ownership", id);
    const entry = requiredObject(candidate, path);
    define(
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

function objectArray(value: JsonValue | undefined, path: string): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    throw invalid(path, "must be an array");
  }
  return Object.freeze(
    value.map((candidate, index) => requiredObject(candidate, `${path}[${String(index)}]`)),
  );
}

function stringArray(value: JsonValue | undefined, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw invalid(path, "must be an array");
  }
  return Object.freeze(
    value.map((candidate, index) => {
      if (typeof candidate !== "string") {
        throw invalid(`${path}[${String(index)}]`, "must be a string");
      }
      return candidate;
    }),
  );
}

function requiredString(value: JsonObject, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw invalid(`${path}.${key}`, "must be a string");
  }
  return field;
}

function requiredBoolean(value: JsonObject, key: string, path: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw invalid(`${path}.${key}`, "must be a boolean");
  }
  return field;
}

/**
 * Narrows a value the top-level walk has already normalized.
 *
 * The section helpers run over subtrees of that walk, so they check shape and hand the existing
 * frozen object back rather than copying and freezing it a second time.
 */
function requiredObject(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw invalid(path, "must be an object");
  }
  return value;
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
    define(result, key, jsonValue(candidate, propertyPath(path, key), depth + 1));
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

/**
 * Adds one key without letting the file decide what the object inherits.
 *
 * `JSON.parse` reports `__proto__` as an ordinary own property, but plain assignment routes that
 * one key through the inherited setter: the field would vanish from the manifest Aura writes back,
 * and its value would become the object's prototype. Defining the property does neither.
 */
function define<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function invalid(path: string, message: string): AuraManifestValidationError {
  return new AuraManifestValidationError(path, message);
}
