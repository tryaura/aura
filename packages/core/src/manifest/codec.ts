import type { AuraManifest, AuraManifestProblem, AuraManifestState } from "@tryaura/aura-sdk";

import { AuraManifestError } from "./error.js";
import { AURA_MANIFEST_SCHEMA_VERSION } from "./protocol.js";
import {
  AuraManifestValidationError,
  UnsupportedAuraManifestVersionError,
  validateAuraManifest,
} from "./schema.js";

/** Creates the writable empty desired state used when no manifest exists yet. */
export function createEmptyAuraManifest(): AuraManifest {
  return Object.freeze({
    apps: Object.freeze({}),
    mcpServers: Object.freeze([]),
    ownership: Object.freeze({}),
    schemaVersion: AURA_MANIFEST_SCHEMA_VERSION,
    skills: Object.freeze([]),
    snippets: Object.freeze([]),
  });
}

/** Parses manifest JSON into a ready or read-only model without exposing source contents. */
export function parseAuraManifest(text: string, path: string): AuraManifestState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const location = parseLocation(error, text);
    const message = `${path} is not valid JSON${location === undefined ? "" : ` at line ${String(location.line)}, column ${String(location.column)}`}. Restore it from an Aura backup or move it aside before writing; Aura left it unchanged.`;
    return readOnly(path, {
      column: location?.column,
      kind: "invalid-json",
      line: location?.line,
      message,
    });
  }

  try {
    return Object.freeze({
      exists: true,
      path,
      status: "ready",
      value: validateAuraManifest(value),
    });
  } catch (error) {
    if (error instanceof UnsupportedAuraManifestVersionError) {
      const newer = error.actualVersion > AURA_MANIFEST_SCHEMA_VERSION;
      return readOnly(path, {
        actualVersion: error.actualVersion,
        kind: "unsupported-version",
        message: newer
          ? `${path} uses manifest schema version ${String(error.actualVersion)}, but this Aura release supports version ${String(AURA_MANIFEST_SCHEMA_VERSION)}. Upgrade Aura before making changes; checks will continue in read-only mode.`
          : `${path} uses unsupported manifest schema version ${String(error.actualVersion)}. Restore a version ${String(AURA_MANIFEST_SCHEMA_VERSION)} backup or move the file aside before writing; Aura left it unchanged.`,
        supportedVersion: AURA_MANIFEST_SCHEMA_VERSION,
      });
    }
    if (error instanceof AuraManifestValidationError) {
      return readOnly(path, {
        jsonPath: error.jsonPath,
        kind: "invalid-schema",
        message: `${path} has an invalid manifest value at ${error.jsonPath}: ${validationMessage(error)}. Restore it from an Aura backup or repair that value before writing; Aura left it unchanged.`,
      });
    }
    throw error;
  }
}

/** Serializes one validated manifest using the canonical on-disk formatting. */
export function serializeAuraManifest(manifest: AuraManifest, path = "Aura manifest"): string {
  try {
    return `${JSON.stringify(validateAuraManifest(manifest), undefined, 2)}\n`;
  } catch (error) {
    if (error instanceof UnsupportedAuraManifestVersionError) {
      const problem: AuraManifestProblem = {
        actualVersion: error.actualVersion,
        kind: "unsupported-version",
        message: `${path} uses unsupported manifest schema version ${String(error.actualVersion)} and cannot be written.`,
        supportedVersion: AURA_MANIFEST_SCHEMA_VERSION,
      };
      throw new AuraManifestError(path, problem, error);
    }
    if (error instanceof AuraManifestValidationError) {
      const problem: AuraManifestProblem = {
        jsonPath: error.jsonPath,
        kind: "invalid-schema",
        message: `${path} has an invalid manifest value at ${error.jsonPath}: ${validationMessage(error)}.`,
      };
      throw new AuraManifestError(path, problem, error);
    }
    throw error;
  }
}

function readOnly(path: string, problem: AuraManifestProblem): AuraManifestState {
  return Object.freeze({ exists: true, path, problem, status: "read-only" });
}

function validationMessage(error: AuraManifestValidationError): string {
  const prefix = `${error.jsonPath}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

function parseLocation(
  error: unknown,
  text: string,
): { readonly column: number; readonly line: number } | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const position = errorPosition(error.message);
  return position === undefined ? errorLineColumn(error.message) : locationAt(text, position);
}

function errorPosition(message: string): number | undefined {
  const captured = /position (?<position>[0-9]+)/u.exec(message)?.groups?.["position"];
  const position = Number(captured);
  return captured !== undefined && Number.isInteger(position) && position >= 0
    ? position
    : undefined;
}

function errorLineColumn(
  message: string,
): { readonly column: number; readonly line: number } | undefined {
  const match = /line (?<line>[0-9]+) column (?<column>[0-9]+)/u.exec(message);
  const line = Number(match?.groups?.["line"]);
  const column = Number(match?.groups?.["column"]);
  return Number.isInteger(line) && Number.isInteger(column) ? { column, line } : undefined;
}

function locationAt(
  text: string,
  position: number,
): { readonly column: number; readonly line: number } {
  const prefix = text.slice(0, position);
  const lines = prefix.split("\n");
  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
}
