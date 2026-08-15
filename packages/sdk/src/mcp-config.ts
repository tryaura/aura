import type { AdapterSourceFile } from "./adapter.js";
import {
  collectMcpServers,
  configStringArray,
  configStringRecord,
  isConfigRecord,
  parseConfigObject,
  redactMcpArguments,
  sanitizeMcpUrl,
} from "./mcp.js";
import type { McpServer, McpTransport } from "./model.js";

/** Application-specific details for the common JSON `mcpServers` configuration shape. */
export interface JsonMcpConfigOptions {
  readonly appId: string;
  /**
   * Expression whose first capture is an environment variable name, as the application writes
   * variable references into header values.
   *
   * Must carry the `g` flag; {@link parseJsonMcpServers} refuses a non-global pattern up front
   * rather than letting `matchAll` throw a bare `TypeError` mid-parse.
   */
  readonly variablePattern: RegExp;
}

/**
 * Normalizes the JSON `mcpServers` format that agent applications share.
 *
 * Claude Code and Cursor write the same document under different paths and differ only in how
 * they spell a variable reference, so the format lives here and each adapter contributes its own
 * pattern. Credential values are discarded or redacted before the result enters the model.
 */
export function parseJsonMcpServers(
  file: AdapterSourceFile,
  options: JsonMcpConfigOptions,
): readonly McpServer[] {
  if (!options.variablePattern.global) {
    throw new TypeError(
      "JsonMcpConfigOptions.variablePattern must be a global regular expression (g flag).",
    );
  }

  const root = parseConfigObject(file.content, (text): unknown => JSON.parse(text));
  return collectMcpServers(file, options.appId, root?.["mcpServers"], (candidate) =>
    parseTransport(candidate, options.variablePattern),
  );
}

/**
 * Chooses a transport from the entry's shape, not from `type` alone.
 *
 * `type` is optional in this configuration format, and an entry that carries a `url` without one
 * is an HTTP server. Keying solely off the discriminant dropped those silently, along with every
 * `sse` server. A `type` naming a transport Aura has no model for is still refused, so a `ws`
 * entry does not get quietly filed as HTTP.
 */
function parseTransport(candidate: unknown, variablePattern: RegExp): McpTransport | undefined {
  if (!isConfigRecord(candidate)) {
    return undefined;
  }

  const type = candidate["type"];
  if (type === "http" || type === "sse") {
    return parseHttp(candidate, type, variablePattern);
  }
  if (type === undefined) {
    return candidate["url"] === undefined
      ? parseStdio(candidate)
      : parseHttp(candidate, "http", variablePattern);
  }
  return type === "stdio" ? parseStdio(candidate) : undefined;
}

function parseStdio(candidate: Readonly<Record<string, unknown>>): McpTransport | undefined {
  const command = candidate["command"];
  const args = configStringArray(candidate["args"]);
  const environmentVariables = objectKeys(candidate["env"]);
  if (typeof command !== "string" || args === undefined || environmentVariables === undefined) {
    return undefined;
  }

  const redacted = redactMcpArguments(args);
  return {
    command,
    type: "stdio",
    ...(redacted.length === 0 ? {} : { args: redacted }),
    ...(environmentVariables.length === 0 ? {} : { environmentVariables }),
  };
}

function parseHttp(
  candidate: Readonly<Record<string, unknown>>,
  type: "http" | "sse",
  variablePattern: RegExp,
): McpTransport | undefined {
  const url = candidate["url"];
  const headerEnvironmentVariables = variablesInObject(candidate["headers"], variablePattern);
  if (typeof url !== "string" || headerEnvironmentVariables === undefined) {
    return undefined;
  }

  const endpoint = sanitizeMcpUrl(url);
  if (endpoint === undefined) {
    return undefined;
  }

  return {
    type,
    url: endpoint,
    ...(headerEnvironmentVariables.length === 0 ? {} : { headerEnvironmentVariables }),
  };
}

/** Names the environment keys an entry declares, whatever it assigns them. */
function objectKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  return isConfigRecord(value) ? Object.keys(value).sort() : undefined;
}

/** Collects the variable references a header block interpolates. */
function variablesInObject(value: unknown, variablePattern: RegExp): readonly string[] | undefined {
  const headers = configStringRecord(value);
  if (headers === undefined) {
    return undefined;
  }

  const variables = new Set<string>();
  for (const header of Object.values(headers)) {
    for (const match of header.matchAll(variablePattern)) {
      const name = match[1];
      if (name !== undefined) {
        variables.add(name);
      }
    }
  }
  return [...variables].sort();
}
