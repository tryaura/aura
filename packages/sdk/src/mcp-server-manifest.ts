import {
  mcpEnvironmentNameProblem,
  mcpServerNameProblem,
  parseMcpServerDefinition,
} from "./mcp-definition.js";
import {
  failure,
  hasError,
  httpUrl,
  isMcpDefinitionRecord,
  jsonPropertyPath,
  requiredNonemptyString,
  variableReferences,
} from "./mcp-definition-values.js";
import type {
  McpCredentialEnvironmentVariable,
  McpDefinitionResult,
  McpServerDefinition,
  McpServerManifest,
} from "./mcp-definition-types.js";

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/** Parses and validates one plugin MCP catalog JSON payload. */
export function parseMcpServerManifest(text: string): McpDefinitionResult<McpServerManifest> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure("$", "must be valid JSON");
  }
  return parseMcpServerManifestValue(value);
}

/** Validates one already-parsed MCP catalog value, as embedded in a repository preset. */
// fallow-ignore-next-line complexity -- every branch reports one precise untrusted JSON field.
export function parseMcpServerManifestValue(
  value: unknown,
): McpDefinitionResult<McpServerManifest> {
  if (!isMcpDefinitionRecord(value)) {
    return failure("$", "must be an object");
  }
  if (value["schemaVersion"] !== 1) {
    return failure("$.schemaVersion", "must be 1");
  }

  const id = requiredNonemptyString(value, "id", "$");
  if (hasError(id)) {
    return id;
  }
  const name = requiredNonemptyString(value, "name", "$");
  if (hasError(name)) {
    return name;
  }
  const serverName = requiredNonemptyString(value, "serverName", "$");
  if (hasError(serverName)) {
    return serverName;
  }
  const serverNameProblem = mcpServerNameProblem(serverName.value);
  if (serverNameProblem !== undefined) {
    return failure("$.serverName", serverNameProblem);
  }
  const description = requiredNonemptyString(value, "description", "$");
  if (hasError(description)) {
    return description;
  }
  const docsUrl = httpUrl(value["docsUrl"], "$.docsUrl");
  if (hasError(docsUrl)) {
    return docsUrl;
  }
  const transport = parseMcpServerDefinition(value["transportTemplate"], "$.transportTemplate");
  if (hasError(transport)) {
    return transport;
  }
  const credentials = credentialEnvironment(value["credentialEnv"]);
  if (hasError(credentials)) {
    return credentials;
  }
  const supportedApps = optionalSupportedApps(value["supportedApps"]);
  if (hasError(supportedApps)) {
    return supportedApps;
  }

  const declared = new Set(credentials.value.map((entry) => entry.name));
  for (const reference of transportEnvironmentReferences(transport.value)) {
    if (!declared.has(reference.name)) {
      return failure(
        reference.path,
        `references undeclared credential environment variable ${reference.name}`,
      );
    }
  }

  return {
    value: Object.freeze({
      credentialEnv: credentials.value,
      description: description.value,
      docsUrl: docsUrl.value,
      id: id.value,
      name: name.value,
      schemaVersion: 1,
      serverName: serverName.value,
      ...(supportedApps.value === undefined ? {} : { supportedApps: supportedApps.value }),
      transportTemplate: transport.value,
    }),
  };
}

function credentialEnvironment(
  value: unknown,
): McpDefinitionResult<readonly McpCredentialEnvironmentVariable[]> {
  if (!Array.isArray(value)) {
    return failure("$.credentialEnv", "must be an array");
  }

  const result: McpCredentialEnvironmentVariable[] = [];
  const names = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const parsed = credentialEnvironmentEntry(candidate, index, names);
    if (hasError(parsed)) {
      return parsed;
    }
    names.add(parsed.value.name);
    result.push(parsed.value);
  }
  return { value: Object.freeze(result) };
}

function credentialEnvironmentEntry(
  value: unknown,
  index: number,
  names: ReadonlySet<string>,
): McpDefinitionResult<McpCredentialEnvironmentVariable> {
  const path = `$.credentialEnv[${String(index)}]`;
  if (!isMcpDefinitionRecord(value)) {
    return failure(path, "must be an object");
  }
  const name = requiredNonemptyString(value, "name", path);
  if (hasError(name)) {
    return name;
  }
  const nameProblem = mcpEnvironmentNameProblem(name.value);
  if (nameProblem !== undefined) {
    return failure(`${path}.name`, nameProblem);
  }
  if (names.has(name.value)) {
    return failure(`${path}.name`, `duplicates environment variable ${name.value}`);
  }

  const description = requiredNonemptyString(value, "description", path);
  if (hasError(description)) {
    return description;
  }
  const setupUrl = optionalHttpUrl(value["setupUrl"], `${path}.setupUrl`);
  if (hasError(setupUrl)) {
    return setupUrl;
  }
  return {
    value: Object.freeze({
      description: description.value,
      name: name.value,
      ...(setupUrl.value === undefined ? {} : { setupUrl: setupUrl.value }),
    }),
  };
}

function optionalSupportedApps(value: unknown): McpDefinitionResult<readonly string[] | undefined> {
  if (value === undefined) {
    return { value: undefined };
  }
  if (!Array.isArray(value)) {
    return failure("$.supportedApps", "must be an array");
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const path = `$.supportedApps[${String(index)}]`;
    if (typeof candidate !== "string" || !APP_ID_PATTERN.test(candidate)) {
      return failure(path, "must be a lowercase application id");
    }
    if (seen.has(candidate)) {
      return failure(path, `duplicates application ${candidate}`);
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return { value: Object.freeze(result) };
}

function transportEnvironmentReferences(
  transport: McpServerDefinition,
): readonly { readonly name: string; readonly path: string }[] {
  if (transport.type === "stdio") {
    return (transport.env ?? []).map((name, index) => ({
      name,
      path: `$.transportTemplate.env[${String(index)}]`,
    }));
  }

  return Object.entries(transport.headers ?? {}).flatMap(([header, value]) =>
    variableReferences(value).map((name) => ({
      name,
      path: jsonPropertyPath("$.transportTemplate.headers", header),
    })),
  );
}

function optionalHttpUrl(value: unknown, path: string): McpDefinitionResult<string | undefined> {
  return value === undefined ? { value: undefined } : httpUrl(value, path);
}
