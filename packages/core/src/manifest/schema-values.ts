import type { JsonObject, JsonValue } from "@tryaura/aura-sdk";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class AuraManifestValidationError extends Error {
  readonly jsonPath: string;

  constructor(jsonPath: string, message: string) {
    super(`${jsonPath}: ${message}`);
    this.name = "AuraManifestValidationError";
    this.jsonPath = jsonPath;
  }
}

export function invalid(path: string, message: string): AuraManifestValidationError {
  return new AuraManifestValidationError(path, message);
}

export function requiredString(value: JsonObject, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw invalid(`${path}.${key}`, "must be a string");
  }
  return field;
}

export function requiredBoolean(value: JsonObject, key: string, path: string): boolean {
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
export function requiredObject(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw invalid(path, "must be an object");
  }
  return value;
}

export function stringArray(value: JsonValue | undefined, path: string): readonly string[] {
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
