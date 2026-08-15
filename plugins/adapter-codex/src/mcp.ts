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
import { parse } from "smol-toml";

export function parseMcpServers(file: AdapterSourceFile): readonly McpServer[] {
  const root = parseConfigObject(file.content, parse);
  return collectMcpServers(file, "codex", root?.["mcp_servers"], parseTransport);
}

function parseTransport(candidate: unknown): McpTransport | undefined {
  if (!isConfigRecord(candidate) || !validEnabled(candidate["enabled"])) {
    return undefined;
  }
  if (candidate["enabled"] === false) {
    return undefined;
  }

  const hasCommand = candidate["command"] !== undefined;
  const hasUrl = candidate["url"] !== undefined;
  if (hasCommand === hasUrl) {
    return undefined;
  }
  return hasCommand ? parseStdio(candidate) : parseHttp(candidate);
}

function parseStdio(candidate: Readonly<Record<string, unknown>>): McpTransport | undefined {
  const command = candidate["command"];
  const args = configStringArray(candidate["args"]);
  const env = configStringRecord(candidate["env"]);
  const envVars = environmentVariableList(candidate["env_vars"]);
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    args === undefined ||
    env === undefined ||
    envVars === undefined
  ) {
    return undefined;
  }

  const redacted = redactMcpArguments(args);
  const environmentVariables = [...new Set([...Object.keys(env), ...envVars])].sort();
  return {
    command,
    type: "stdio",
    ...(redacted.length === 0 ? {} : { args: redacted }),
    ...(environmentVariables.length === 0 ? {} : { environmentVariables }),
  };
}

function parseHttp(candidate: Readonly<Record<string, unknown>>): McpTransport | undefined {
  const rawUrl = candidate["url"];
  const bearer = optionalString(candidate["bearer_token_env_var"]);
  const headers = configStringRecord(candidate["http_headers"]);
  const envHeaders = configStringRecord(candidate["env_http_headers"]);
  if (
    typeof rawUrl !== "string" ||
    bearer === undefined ||
    headers === undefined ||
    envHeaders === undefined
  ) {
    return undefined;
  }

  const url = sanitizeMcpUrl(rawUrl);
  if (url === undefined) {
    return undefined;
  }

  const headerEnvironmentVariables = [
    ...new Set([...Object.values(envHeaders), ...(bearer.length === 0 ? [] : [bearer])]),
  ].sort();
  return {
    type: "http",
    url,
    ...(headerEnvironmentVariables.length === 0 ? {} : { headerEnvironmentVariables }),
  };
}

/**
 * Reads `env_vars`, which Codex accepts either as plain names or as `{ name = "..." }` tables.
 */
function environmentVariableList(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (isConfigRecord(entry) && typeof entry["name"] === "string") {
      names.push(entry["name"]);
    } else {
      return undefined;
    }
  }
  return names;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || typeof value === "string" ? (value ?? "") : undefined;
}

function validEnabled(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}
