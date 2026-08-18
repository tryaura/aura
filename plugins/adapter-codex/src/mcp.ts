import {
  collectMcpServers,
  configStringArray,
  configStringRecord,
  EMPTY_COLLECTION,
  isConfigRecord,
  inspectJsonMcpSecrets,
  parseConfigObject,
  redactMcpArguments,
  sanitizeMcpUrl,
  stdioTransport,
  type AdapterSourceFile,
  type McpEntryCollection,
  type McpEntryParse,
  type McpTransport,
  type McpSecretSighting,
} from "@tryaura/aura-sdk";
import { parse } from "smol-toml";

/** What `config.toml` contributed to the MCP model. */
export interface CodexMcpConfig extends McpEntryCollection {
  /**
   * Whether the file held something other than parseable TOML.
   *
   * Kept apart from an empty server list because the two need opposite advice: one user has no MCP
   * servers, the other has servers that are silently not loading.
   */
  readonly malformed: boolean;
}

export function parseMcpServers(file: AdapterSourceFile): CodexMcpConfig {
  const root = parseConfigObject(file.content, parse);
  if (root === undefined) {
    return { ...EMPTY_COLLECTION, malformed: file.content !== undefined };
  }

  return {
    ...collectMcpServers(file, "codex", root["mcp_servers"], parseEntry, (candidate, serverName) =>
      inspectCodexSecrets(file, candidate, serverName),
    ),
    malformed: false,
  };
}

function inspectCodexSecrets(
  file: AdapterSourceFile,
  candidate: unknown,
  serverName: string,
): readonly McpSecretSighting[] {
  if (!isConfigRecord(candidate)) {
    return [];
  }
  return inspectJsonMcpSecrets(
    {
      args: candidate["args"],
      env: candidate["env"],
      headers: candidate["http_headers"],
      url: candidate["url"],
    },
    {
      appId: "codex",
      recordPath: ["mcp_servers"],
      scope: file.spec.scope,
      serverName,
      sourceId: file.spec.id,
      variablePattern: /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    },
  );
}

const DISABLED: McpEntryParse = Object.freeze({ reason: "disabled" });
const UNRECOGNIZED: McpEntryParse = Object.freeze({ reason: "unrecognized" });

function parseEntry(candidate: unknown): McpEntryParse {
  if (!isConfigRecord(candidate)) {
    return UNRECOGNIZED;
  }
  if (!validEnabled(candidate["enabled"]) || candidate["enabled"] === false) {
    return DISABLED;
  }

  const hasCommand = candidate["command"] !== undefined;
  const hasUrl = candidate["url"] !== undefined;
  if (hasCommand === hasUrl) {
    return UNRECOGNIZED;
  }
  const transport = hasCommand ? parseStdio(candidate) : parseHttp(candidate);
  return transport === undefined ? UNRECOGNIZED : { transport };
}

interface StdioFields {
  readonly args: readonly string[];
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly envVars: readonly string[];
}

function stdioFields(candidate: Readonly<Record<string, unknown>>): StdioFields | undefined {
  const command = candidate["command"];
  const args = configStringArray(candidate["args"]);
  const env = configStringRecord(candidate["env"]);
  const envVars = environmentVariableList(candidate["env_vars"]);
  return typeof command === "string" &&
    command.length > 0 &&
    args !== undefined &&
    env !== undefined &&
    envVars !== undefined
    ? { args, command, env, envVars }
    : undefined;
}

function parseStdio(candidate: Readonly<Record<string, unknown>>): McpTransport | undefined {
  const fields = stdioFields(candidate);
  if (fields === undefined) {
    return undefined;
  }

  const { args, command, env, envVars } = fields;
  const redacted = redactMcpArguments(args);
  return stdioTransport({
    args: redacted,
    command,
    environmentVariables: [...new Set([...Object.keys(env), ...envVars])].sort(),
    // `env` assigns values and `env_vars` names variables to forward. Anything in the first is a
    // literal Codex passes through verbatim, which is the shape desired state exists to replace.
    inlineCredentialValues:
      Object.keys(env).length > 0 || redacted.some((argument, index) => argument !== args[index]),
  });
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
    ...(Object.keys(headers).length === 0 ? {} : { inlineCredentialValues: true }),
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
