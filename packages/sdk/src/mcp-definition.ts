import { isMcpCredentialLiteral } from "./mcp.js";
import { transportExtensionProblem } from "./mcp-definition-extensions.js";
import type {
  HttpMcpServerDefinition,
  McpDefinitionResult,
  McpServerDefinition,
  StdioMcpServerDefinition,
} from "./mcp-definition-types.js";
import {
  defineOwnProperty,
  failure,
  hasError,
  httpUrl,
  isMcpDefinitionRecord,
  jsonPropertyPath,
  optionalStringArray,
  requiredNonemptyString,
  VARIABLE_REFERENCE_PATTERN,
  variableReferences,
} from "./mcp-definition-values.js";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const RESERVED_SERVER_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * What a header value may contain besides its `${VARIABLE}` references.
 *
 * Requiring a reference is not on its own a guarantee: `"abcd1234secretvalue ${UNUSED}"` satisfies
 * it while carrying the secret in plain text, and no credential pattern recognizes an arbitrary
 * token. Bounding the rest of the value to a short run of letters, spaces, and hyphens —
 * `"Bearer "`, `"Basic "`, `"Token "`, `"Sentry-Bearer "` — leaves room for the framing real
 * headers need and nowhere to hide a credential, which the recognized-literal check alone cannot
 * promise. The hyphen is here for vendor-scoped schemes: Sentry's remote MCP reserves plain
 * `Bearer` for its own OAuth tokens and takes a user's API token under `Sentry-Bearer`.
 */
const HEADER_FRAMING_PATTERN = /^[A-Za-z -]{0,16}$/u;

/** Returns why `name` is unsafe as an MCP server key, or `undefined` when it is valid. */
export function mcpServerNameProblem(name: string): string | undefined {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return "must match /^[a-zA-Z0-9._-]+$/";
  }
  if (name.includes("..")) {
    return 'must not contain ".."';
  }
  if (RESERVED_SERVER_NAMES.has(name.toLowerCase())) {
    return "must not be a reserved object property name";
  }
  return undefined;
}

/** Returns why `name` cannot be stored as an environment-variable reference. */
export function mcpEnvironmentNameProblem(name: string): string | undefined {
  return ENVIRONMENT_NAME_PATTERN.test(name)
    ? undefined
    : "must match /^[A-Z_][A-Z0-9_]*$/ and contain a name, never NAME=value";
}

/** Returns the unique environment-variable references required by a transport. */
export function mcpEnvironmentVariableNames(transport: McpServerDefinition): readonly string[] {
  const names =
    transport.type === "stdio"
      ? (transport.env ?? [])
      : Object.values(transport.headers ?? {}).flatMap(variableReferences);
  return Object.freeze([...new Set(names)].sort());
}

/**
 * Validates and normalizes a transport from parsed JSON-compatible data.
 *
 * Fields this release does not define are preserved rather than dropped, so a definition written
 * by a newer Aura survives a round-trip through an older one instead of silently losing part of
 * itself. {@link transportExtensionProblem} is what keeps that safe.
 */
export function parseMcpServerDefinition(
  value: unknown,
  path = "$",
): McpDefinitionResult<McpServerDefinition> {
  if (!isMcpDefinitionRecord(value)) {
    return failure(path, "must be an object");
  }

  if (value["type"] === "stdio") {
    return withExtensions(value, path, "stdio", parseStdioDefinition(value, path));
  }
  if (value["type"] === "http") {
    return withExtensions(value, path, "http", parseHttpDefinition(value, path));
  }
  return failure(`${path}.type`, 'must be either "stdio" or "http"');
}

function withExtensions(
  source: Readonly<Record<string, unknown>>,
  path: string,
  type: "http" | "stdio",
  parsed: McpDefinitionResult<McpServerDefinition>,
): McpDefinitionResult<McpServerDefinition> {
  if (hasError(parsed)) {
    return parsed;
  }
  const problem = transportExtensionProblem(source, path, type);
  if (problem !== undefined) {
    return { error: problem };
  }
  return { value: Object.freeze({ ...source, ...parsed.value }) };
}

function parseStdioDefinition(
  value: Readonly<Record<string, unknown>>,
  path: string,
): McpDefinitionResult<StdioMcpServerDefinition> {
  const command = stdioCommand(value, path);
  if (hasError(command)) {
    return command;
  }
  const args = stdioArgs(value["args"], `${path}.args`);
  if (hasError(args)) {
    return args;
  }
  const env = optionalEnvironmentNames(value["env"], `${path}.env`);
  if (hasError(env)) {
    return env;
  }

  return {
    value: Object.freeze({
      ...(args.value === undefined ? {} : { args: args.value }),
      command: command.value,
      ...(env.value === undefined ? {} : { env: env.value }),
      type: "stdio",
    }),
  };
}

function stdioCommand(
  value: Readonly<Record<string, unknown>>,
  path: string,
): McpDefinitionResult<string> {
  const command = requiredNonemptyString(value, "command", path);
  if (hasError(command) || !isMcpCredentialLiteral(command.value)) {
    return command;
  }
  return failure(`${path}.command`, "must not contain a credential literal");
}

function stdioArgs(
  value: unknown,
  path: string,
): McpDefinitionResult<readonly string[] | undefined> {
  const args = optionalStringArray(value, path);
  if (hasError(args)) {
    return args;
  }
  for (const [index, argument] of (args.value ?? []).entries()) {
    if (isMcpCredentialLiteral(argument)) {
      return failure(`${path}[${String(index)}]`, "must not contain a credential literal");
    }
  }
  return args;
}

function parseHttpDefinition(
  value: Readonly<Record<string, unknown>>,
  path: string,
): McpDefinitionResult<HttpMcpServerDefinition> {
  const url = httpUrl(value["url"], `${path}.url`);
  if (hasError(url)) {
    return url;
  }
  if (isMcpCredentialLiteral(url.value)) {
    return failure(`${path}.url`, "must not contain a credential literal");
  }

  const headers = optionalHeaders(value["headers"], `${path}.headers`);
  if (hasError(headers)) {
    return headers;
  }

  return {
    value: Object.freeze({
      ...(headers.value === undefined ? {} : { headers: headers.value }),
      type: "http",
      url: url.value,
    }),
  };
}

function optionalEnvironmentNames(
  value: unknown,
  path: string,
): McpDefinitionResult<readonly string[] | undefined> {
  const entries = optionalStringArray(value, path);
  if (hasError(entries) || entries.value === undefined) {
    return entries;
  }

  const seen = new Set<string>();
  for (const [index, name] of entries.value.entries()) {
    const problem = mcpEnvironmentNameProblem(name);
    if (problem !== undefined) {
      return failure(`${path}[${String(index)}]`, problem);
    }
    if (seen.has(name)) {
      return failure(`${path}[${String(index)}]`, `duplicates environment variable ${name}`);
    }
    seen.add(name);
  }
  return entries;
}

function optionalHeaders(
  value: unknown,
  path: string,
): McpDefinitionResult<Readonly<Record<string, string>> | undefined> {
  if (value === undefined) {
    return { value: undefined };
  }
  if (!isMcpDefinitionRecord(value)) {
    return failure(path, "must be an object");
  }

  const result: Record<string, string> = {};
  for (const [name, candidate] of Object.entries(value)) {
    const fieldPath = jsonPropertyPath(path, name);
    if (!HEADER_NAME_PATTERN.test(name)) {
      return failure(fieldPath, "has an invalid HTTP header name");
    }
    if (typeof candidate !== "string") {
      return failure(fieldPath, "must be a string");
    }
    const problem = headerValueProblem(candidate);
    if (problem !== undefined) {
      return failure(fieldPath, problem);
    }
    defineOwnProperty(result, name, candidate);
  }
  return { value: Object.freeze(result) };
}

/** Returns why a header value cannot be stored, or `undefined` when it holds no credential. */
function headerValueProblem(value: string): string | undefined {
  if (variableReferences(value).length === 0) {
    return "must contain a ${VARIABLE} reference";
  }

  const framing = value.replace(VARIABLE_REFERENCE_PATTERN, "");
  if (framing.includes("$")) {
    return "contains an invalid environment-variable reference";
  }
  if (isMcpCredentialLiteral(framing)) {
    return "must not contain a credential literal";
  }
  if (!HEADER_FRAMING_PATTERN.test(framing)) {
    return 'must be ${VARIABLE} references plus short framing text such as "Bearer "';
  }
  return undefined;
}
