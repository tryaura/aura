import {
  collectMcpServers,
  configStringArray,
  configStringRecord,
  isConfigRecord,
  parseConfigObject,
  redactMcpArguments,
  sanitizeMcpUrl,
  type AdapterSourceFile,
  type McpServer,
  type McpTransport,
} from "@tryaura/aura-sdk";

const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?\}/gu;

export function parseMcpServers(file: AdapterSourceFile): readonly McpServer[] {
  const root = parseConfigObject(file.content, (text): unknown => JSON.parse(text));
  return collectMcpServers(file, "claude-code", root?.["mcpServers"], parseTransport);
}

/**
 * Chooses a transport from the entry's shape, not from `type` alone.
 *
 * `type` is optional in Claude Code's configuration, and an entry that carries a `url` without one
 * is an HTTP server. Keying solely off the discriminant dropped those silently, along with every
 * `sse` server. A `type` naming a transport Aura has no model for is still refused, so a `ws`
 * entry does not get quietly filed as HTTP.
 */
function parseTransport(candidate: unknown): McpTransport | undefined {
  if (!isConfigRecord(candidate)) {
    return undefined;
  }

  const type = candidate["type"];
  if (type === "http" || type === "sse") {
    return parseHttp(candidate, type);
  }
  if (type === undefined) {
    return candidate["url"] === undefined ? parseStdio(candidate) : parseHttp(candidate, "http");
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
): McpTransport | undefined {
  const url = candidate["url"];
  const headerEnvironmentVariables = variablesInObject(candidate["headers"]);
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

/** Collects the `${VAR}` references a header block interpolates. */
function variablesInObject(value: unknown): readonly string[] | undefined {
  const headers = configStringRecord(value);
  if (headers === undefined) {
    return undefined;
  }

  const variables = new Set<string>();
  for (const header of Object.values(headers)) {
    for (const match of header.matchAll(VARIABLE_PATTERN)) {
      const name = match[1];
      if (name !== undefined) {
        variables.add(name);
      }
    }
  }
  return [...variables].sort();
}
