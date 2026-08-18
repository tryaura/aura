import {
  type McpSecretRedaction,
  type McpSecretSighting,
  type McpSecretTransform,
  type McpSecretTransformInput,
} from "@tryaura/aura-sdk";
import { parseTOML, type AST } from "toml-eslint-parser";
import { parse } from "smol-toml";

import {
  applyEdits,
  replaceOrInsert,
  replaceRecord,
  tomlArrayValues,
  tomlInlineRecord,
  tomlString,
  type TextEdit,
} from "./toml-edit.js";
import { findServerTable, locatorValueNode, serverFields } from "./toml-lookup.js";

interface ServerChanges {
  readonly envNames: Set<string>;
  readonly headers: Map<string, string>;
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

/** Codex can forward stdio env keys and map HTTP headers to environment variables. */
export const transformMcpSecrets: McpSecretTransform = {
  redact: redactToml,
  rewrite: rewriteToml,
  supports: (sighting) =>
    (sighting.locator.kind === "env" && ENV_NAME_PATTERN.test(sighting.locator.name)) ||
    sighting.locator.kind === "header",
};

/**
 * Masks each sighting in place, reporting the ones this document does not contain.
 *
 * A sighting whose server entry is absent is reported rather than skipped. The two look identical
 * from here — nothing was masked either way — but only one of them means the credential is still in
 * the text, and the caller cannot tell them apart from a returned string.
 */
function redactToml(input: McpSecretTransformInput): McpSecretRedaction | undefined {
  let ast: AST.TOMLProgram;
  try {
    ast = parseTOML(input.content);
  } catch {
    return undefined;
  }

  const unresolved: string[] = [];
  const edits: TextEdit[] = [];
  for (const sighting of input.sightings) {
    if (serverFields(ast, sighting.serverName).length === 0) {
      unresolved.push(sighting.field);
      continue;
    }
    const node = locatorValueNode(ast, sighting.serverName, sighting.locator);
    if (node === undefined) {
      continue;
    }
    edits.push({ end: node.range[1], start: node.range[0], text: tomlString("[redacted]") });
  }
  const content = applyEdits(input.content, edits);
  return content === undefined ? undefined : { content, unresolved };
}

// fallow-ignore-next-line complexity -- coordinates range edits for Codex's three schema-native secret mappings.
function rewriteToml(
  input: McpSecretTransformInput,
):
  | { readonly content: string; readonly rewrittenFields: readonly string[] }
  | { readonly refusal: string } {
  let ast: AST.TOMLProgram;
  let root: unknown;
  try {
    ast = parseTOML(input.content);
    root = parse(input.content);
  } catch {
    return { refusal: "Codex's MCP configuration is not valid TOML." };
  }
  if (!isRecord(root) || !isRecord(root["mcp_servers"])) {
    return { refusal: "Codex's MCP server table could not be located." };
  }

  const edits: TextEdit[] = [];
  for (const [serverName, change] of collectChanges(input.sightings)) {
    const server = root["mcp_servers"][serverName];
    // Only a standalone `[mcp_servers.<name>]` table has somewhere to append `env_vars` to. An
    // inline entry is left for the user, and reports itself unrewritten below.
    const table = findServerTable(ast, serverName);
    if (isRecord(server) && table !== undefined) {
      rewriteServer(input.content, ast, table, server, change, edits);
    }
  }

  const content = applyEdits(input.content, edits);
  if (content === undefined) {
    return { refusal: "The safe Codex rewrite produced overlapping edits." };
  }
  let finalRoot: unknown;
  try {
    finalRoot = parse(content);
  } catch {
    return { refusal: "The safe Codex rewrite did not produce valid TOML." };
  }
  const rewrittenFields = input.sightings
    .filter((sighting) => isRewritten(finalRoot, sighting))
    .map((sighting) => sighting.field);
  return { content, rewrittenFields };
}

// fallow-ignore-next-line complexity -- both Codex mappings edit the same table and share its edits.
function rewriteServer(
  source: string,
  ast: AST.TOMLProgram,
  table: AST.TOMLTable,
  server: Readonly<Record<string, unknown>>,
  change: ServerChanges,
  edits: TextEdit[],
): void {
  const env = stringRecord(server["env"]);
  const existingEnvVars = envVarValues(server["env_vars"]);
  if (change.envNames.size > 0 && env !== undefined && existingEnvVars !== undefined) {
    const existingNames = environmentVariableNames(existingEnvVars);
    const additions = [...change.envNames].filter((name) => !existingNames.includes(name)).sort();
    replaceRecord(ast, source, table, ["env"], omitKeys(env, change.envNames), edits);
    replaceOrInsert(
      source,
      table,
      "env_vars",
      tomlArrayValues([...existingEnvVars, ...additions]),
      edits,
    );
  }

  const headers = stringRecord(server["http_headers"]);
  const existingEnvHeaders = stringRecord(server["env_http_headers"]);
  if (change.headers.size === 0 || headers === undefined || existingEnvHeaders === undefined) {
    return;
  }
  replaceRecord(
    ast,
    source,
    table,
    ["http_headers"],
    omitKeys(headers, new Set(change.headers.keys())),
    edits,
  );
  const envHeaders = { ...existingEnvHeaders };
  let bearerName: string | undefined;
  for (const [name, envName] of change.headers) {
    if (name.toLowerCase() === "authorization" && /^\s*bearer\s+/iu.test(headers[name] ?? "")) {
      bearerName = envName;
    } else {
      envHeaders[name] = envName;
    }
  }
  if (bearerName !== undefined) {
    replaceOrInsert(source, table, "bearer_token_env_var", tomlString(bearerName), edits);
  }
  if (Object.keys(envHeaders).length > 0) {
    replaceOrInsert(source, table, "env_http_headers", tomlInlineRecord(envHeaders), edits);
  }
}

function collectChanges(sightings: readonly McpSecretSighting[]): Map<string, ServerChanges> {
  const changes = new Map<string, ServerChanges>();
  for (const sighting of sightings) {
    let change = changes.get(sighting.serverName);
    if (change === undefined) {
      change = { envNames: new Set(), headers: new Map() };
      changes.set(sighting.serverName, change);
    }
    if (sighting.locator.kind === "env" && ENV_NAME_PATTERN.test(sighting.locator.name)) {
      change.envNames.add(sighting.locator.name);
    } else if (sighting.locator.kind === "header") {
      change.headers.set(sighting.locator.name, sighting.suggestedEnvName);
    }
  }
  return changes;
}

// fallow-ignore-next-line complexity -- validates both supported Codex mapping forms after serialization.
function isRewritten(root: unknown, sighting: McpSecretSighting): boolean {
  if (!isRecord(root) || !isRecord(root["mcp_servers"])) {
    return false;
  }
  const server = root["mcp_servers"][sighting.serverName];
  if (!isRecord(server)) {
    return false;
  }
  if (sighting.locator.kind === "env") {
    const env = stringRecord(server["env"]);
    const envVars = environmentVariableNames(envVarValues(server["env_vars"]) ?? []);
    return (
      env !== undefined &&
      !Object.hasOwn(env, sighting.locator.name) &&
      envVars.includes(sighting.locator.name)
    );
  }
  if (sighting.locator.kind === "header") {
    const headers = stringRecord(server["http_headers"]);
    const envHeaders = stringRecord(server["env_http_headers"]);
    return (
      headers !== undefined &&
      !Object.hasOwn(headers, sighting.locator.name) &&
      (server["bearer_token_env_var"] === sighting.suggestedEnvName ||
        envHeaders?.[sighting.locator.name] === sighting.suggestedEnvName)
    );
  }
  return false;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined;
    }
    result[name] = entry;
  }
  return result;
}

function envVarValues(value: unknown): readonly unknown[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every(
    (entry) => typeof entry === "string" || (isRecord(entry) && typeof entry["name"] === "string"),
  )
    ? value
    : undefined;
}

function environmentVariableNames(values: readonly unknown[]): readonly string[] {
  return values.flatMap((value) => {
    if (typeof value === "string") {
      return [value];
    }
    return isRecord(value) && typeof value["name"] === "string" ? [value["name"]] : [];
  });
}

function omitKeys(
  source: Readonly<Record<string, string>>,
  names: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => !names.has(name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
