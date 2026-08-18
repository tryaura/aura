import type { AdapterSourceFile } from "./adapter.js";
import {
  collectMcpServers,
  configStringArray,
  configStringRecord,
  EMPTY_COLLECTION,
  isConfigRecord,
  parseConfigObject,
  redactMcpArguments,
  sanitizeMcpUrl,
  stdioTransport,
  type McpEntryCollection,
  type McpEntryParse,
} from "./mcp.js";
import { inspectJsonMcpSecrets } from "./mcp-secret-inspect.js";
import type { McpTransport } from "./model.js";

/** Application-specific details for the common JSON `mcpServers` configuration shape. */
export interface JsonMcpConfigOptions {
  readonly appId: string;
  /** Object path from the document root to the record containing the named servers. */
  readonly recordPath?: readonly string[] | undefined;
  /**
   * Expression whose first capture is an environment variable name, as the application writes
   * variable references into header values.
   *
   * Must carry the `g` flag; {@link parseJsonMcpServers} refuses a non-global pattern up front
   * rather than letting `matchAll` throw a bare `TypeError` mid-parse.
   */
  readonly variablePattern: RegExp;
}

/** The parse outcome for one JSON MCP configuration file. */
export interface ParsedJsonMcpConfig extends McpEntryCollection {
  /**
   * Whether the file held something other than a JSON object.
   *
   * Kept apart from an empty server list because the two need opposite advice: one user has no MCP
   * servers, the other has servers that are silently not loading.
   */
  readonly malformed: boolean;
}

/** Parses the common JSON MCP shape while distinguishing malformed input from an empty list. */
export function parseJsonMcpConfig(
  file: AdapterSourceFile,
  options: JsonMcpConfigOptions,
): ParsedJsonMcpConfig {
  const root = parseConfigObject(file.content, (text): unknown => JSON.parse(text));
  if (root === undefined) {
    return { ...EMPTY_COLLECTION, malformed: file.content !== undefined };
  }
  return { ...collectJsonMcpServers(file, root["mcpServers"], options), malformed: false };
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
): McpEntryCollection {
  const root = parseConfigObject(file.content, (text): unknown => JSON.parse(text));
  return collectJsonMcpServers(file, root?.["mcpServers"], options);
}

/**
 * Normalizes an `mcpServers` record the caller has already parsed out of its document.
 *
 * Separate from {@link parseJsonMcpServers} for the configurations that keep more than one such
 * record: Claude Code stores global servers beside a `projects` map of per-directory ones, and
 * reaching them through the whole-file entry point would parse the largest file in a scan twice.
 */
export function collectJsonMcpServers(
  file: AdapterSourceFile,
  entries: unknown,
  options: JsonMcpConfigOptions,
): McpEntryCollection {
  if (!options.variablePattern.global) {
    throw new TypeError(
      "JsonMcpConfigOptions.variablePattern must be a global regular expression (g flag).",
    );
  }

  return collectMcpServers(
    file,
    options.appId,
    entries,
    (candidate) => parseEntry(candidate, options.variablePattern),
    (candidate, serverName) =>
      inspectJsonMcpSecrets(candidate, {
        appId: options.appId,
        recordPath: options.recordPath ?? ["mcpServers"],
        scope: file.spec.scope,
        serverName,
        sourceId: file.spec.id,
        variablePattern: options.variablePattern,
      }),
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
function parseEntry(candidate: unknown, variablePattern: RegExp): McpEntryParse {
  if (!isConfigRecord(candidate)) {
    return UNRECOGNIZED;
  }
  if (!isEnabled(candidate["enabled"])) {
    return DISABLED;
  }

  const transport = parseTransportType(candidate, variablePattern);
  return transport === undefined ? UNRECOGNIZED : { transport };
}

const DISABLED: McpEntryParse = Object.freeze({ reason: "disabled" });
const UNRECOGNIZED: McpEntryParse = Object.freeze({ reason: "unrecognized" });

/**
 * Whether the application will start this entry.
 *
 * An `enabled` that is neither absent nor `true` counts as off: the applications that honor the
 * field disagree on what a non-boolean means, and treating an entry Aura cannot vouch for as
 * running is the reading that produces a wrong answer silently.
 */
function isEnabled(value: unknown): boolean {
  return value === undefined || value === true;
}

function parseTransportType(
  candidate: Readonly<Record<string, unknown>>,
  variablePattern: RegExp,
): McpTransport | undefined {
  const type = candidate["type"];
  if (type === "http" || type === "sse") {
    return parseHttp(candidate, type, variablePattern);
  }
  if (type === undefined) {
    return candidate["url"] === undefined
      ? parseStdio(candidate, variablePattern)
      : parseHttp(candidate, "http", variablePattern);
  }
  return type === "stdio" ? parseStdio(candidate, variablePattern) : undefined;
}

function parseStdio(
  candidate: Readonly<Record<string, unknown>>,
  variablePattern: RegExp,
): McpTransport | undefined {
  const command = candidate["command"];
  const args = configStringArray(candidate["args"]);
  const environmentVariables = objectKeys(candidate["env"]);
  if (typeof command !== "string" || args === undefined || environmentVariables === undefined) {
    return undefined;
  }

  const redacted = redactMcpArguments(args);
  return stdioTransport({
    args: redacted,
    command,
    environmentVariables,
    inlineCredentialValues:
      redacted.some((argument, index) => argument !== args[index]) ||
      hasLiteralValue(candidate["env"], variablePattern),
  });
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
    ...(hasLiteralValue(candidate["headers"], variablePattern)
      ? { inlineCredentialValues: true }
      : {}),
  };
}

/** Whether any value in a record supplies content of its own rather than naming a variable. */
function hasLiteralValue(value: unknown, variablePattern: RegExp): boolean {
  if (!isConfigRecord(value)) {
    return false;
  }
  return Object.values(value).some(
    (entry) => typeof entry !== "string" || holdsLiteral(entry, variablePattern),
  );
}

/**
 * Whether a configured value carries anything beyond variable references and surrounding syntax.
 *
 * `${TOKEN}` and `Bearer ${TOKEN}` name a credential; `sk-live-…` and `Bearer sk-live-…` are one.
 * Removing every reference and every non-secret scheme word leaves nothing in the first case, so
 * what remains is the part the user pasted in.
 */
function holdsLiteral(value: string, variablePattern: RegExp): boolean {
  return (
    value
      .replaceAll(variablePattern, "")
      .replace(/^\s*bearer\b/iu, "")
      .trim().length > 0
  );
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
