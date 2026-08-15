import { URL } from "node:url";

import type { AdapterSourceFile } from "./adapter.js";
import type { McpServer, McpTransport } from "./model.js";

/** Stands in for a value that could be a credential. */
const REDACTED = "[redacted]";

/**
 * Names whose value is treated as a credential.
 *
 * Matched against the trailing word of a flag or variable name, so `--api-key`, `DOCS_TOKEN`, and
 * `--password` all hit while `--keyfile` and `--tokenizer` do not.
 */
const SECRET_NAME_PATTERN =
  /(?:^|[-_])(?:api[-_]?keys?|keys?|secrets?|tokens?|passwords?|passwd|pwd|auth|credentials?|bearer)$/iu;

/** Values that announce themselves as credentials whatever flag they follow. */
const SECRET_VALUE_PATTERN =
  /^(?:sk|pk|rk)[-_]|^(?:gh[opsur]|github_pat)_|^xox[abpsr]-|^AKIA[0-9A-Z]{16}$/u;

/** A name with its value joined on, as in `--api-key=abc` or `DOCS_TOKEN=abc`. */
const INLINE_VALUE_PATTERN = /^(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=(.*)$/su;

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
 * Normalizes the JSON MCP format shared by agent applications.
 *
 * Credential values are discarded or redacted before the result enters the workspace model.
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

  const root = parseJsonObject(file.content);
  const servers = root?.["mcpServers"];
  if (!isRecord(servers)) {
    return [];
  }

  const parsed: McpServer[] = [];
  for (const [name, candidate] of Object.entries(servers)) {
    const transport = parseTransport(candidate, options.variablePattern);
    if (transport !== undefined) {
      parsed.push({
        appId: options.appId,
        name,
        scope: file.spec.scope,
        sourceId: file.spec.id,
        transport,
      });
    }
  }
  return parsed;
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
  if (!isRecord(candidate)) {
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
  const args = stringArray(candidate["args"]);
  const environmentVariables = objectKeys(candidate["env"]);
  if (typeof command !== "string" || args === undefined || environmentVariables === undefined) {
    return undefined;
  }

  const redacted = redactArguments(args);
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

  const endpoint = sanitizeUrl(url);
  if (endpoint === undefined) {
    return undefined;
  }

  return {
    type,
    url: endpoint,
    ...(headerEnvironmentVariables.length === 0 ? {} : { headerEnvironmentVariables }),
  };
}

/**
 * Strips the parts of an endpoint that carry credentials.
 *
 * Userinfo and query parameter values are both ordinary places to put a token, and the snapshot
 * this feeds is rendered back to the user. Parameter names stay, because which parameters a server
 * expects is worth reporting; their values never are. An endpoint that is not a URL at all is
 * refused rather than passed through unexamined.
 *
 * Path segments identify the endpoint and are kept, except ones that announce themselves as
 * credentials — some servers embed the token in the path itself. A token the pattern does not
 * recognize still passes through, so the path is a weaker guarantee than userinfo and query.
 *
 * The query is rebuilt by hand: `URLSearchParams` serializes with the form encoding, which would
 * turn the placeholder into `%5Bredacted%5D`.
 */
function sanitizeUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  url.pathname = url.pathname
    .split("/")
    .map((segment) => (SECRET_VALUE_PATTERN.test(segment) ? REDACTED : segment))
    .join("/");
  const names = [...new Set(url.searchParams.keys())];
  url.search = names.map((name) => `${name}=${REDACTED}`).join("&");
  return url.toString();
}

/**
 * Replaces argument values that carry credentials, keeping everything that identifies the server.
 *
 * Three shapes cover what agent applications write: a value joined to its flag
 * (`--api-key=abc`), a value in the argument after its flag (`--api-key abc`), and a bare value
 * that is recognizably a token whatever precedes it. A flag never consumes another flag as its
 * value, so a server run with `--token --verbose` keeps the second one.
 */
function redactArguments(args: readonly string[]): readonly string[] {
  const redacted: string[] = [];
  let afterSecretFlag = false;

  for (const argument of args) {
    redacted.push(redactArgument(argument, afterSecretFlag));
    afterSecretFlag = expectsSecretValue(argument);
  }

  return redacted;
}

function redactArgument(argument: string, afterSecretFlag: boolean): string {
  if (afterSecretFlag && !isFlag(argument)) {
    return REDACTED;
  }

  const inlineName = INLINE_VALUE_PATTERN.exec(argument)?.[1];
  if (inlineName !== undefined && isSecretName(inlineName)) {
    return `${inlineName}=${REDACTED}`;
  }

  return SECRET_VALUE_PATTERN.test(argument) ? REDACTED : argument;
}

/** Whether this argument is a flag whose value lands in the next one. */
function expectsSecretValue(argument: string): boolean {
  return isFlag(argument) && !INLINE_VALUE_PATTERN.test(argument) && isSecretName(argument);
}

function isFlag(argument: string): boolean {
  return argument.startsWith("-");
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name.replace(/^-+/u, ""));
}

function parseJsonObject(
  content: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (content === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function objectKeys(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  return isRecord(value) ? Object.keys(value).sort() : undefined;
}

function variablesInObject(value: unknown, variablePattern: RegExp): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    return undefined;
  }

  const variables = new Set<string>();
  for (const header of Object.values(value)) {
    if (typeof header !== "string") {
      continue;
    }
    for (const match of header.matchAll(variablePattern)) {
      const name = match[1];
      if (name !== undefined) {
        variables.add(name);
      }
    }
  }
  return [...variables].sort();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
