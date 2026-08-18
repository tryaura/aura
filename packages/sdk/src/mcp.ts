import { URL } from "node:url";

import type { AdapterSourceFile } from "./adapter.js";
import type { McpServer, McpTransport, UnusableMcpReason, UnusableMcpServer } from "./model.js";

/** Stands in for a value that could be a credential. */
const REDACTED = "[redacted]";

/** Names whose value is treated as a credential. */
const SECRET_NAME_PATTERN =
  /(?:^|[-_])(?:api[-_]?keys?|keys?|secrets?|tokens?|passwords?|passwd|pwd|auth(?:orization)?|credentials?|bearer)$/iu;

/** Values that announce themselves as credentials whatever flag they follow. */
const SECRET_VALUE_PATTERN =
  /^(?:sk|pk|rk)[-_]|^(?:gh[opsur]|github_pat)_|^xox[abpsr]-|^AKIA[0-9A-Z]{16}$/u;

/** Whether a string contains a token recognizable by Aura's MCP redaction boundary. */
export function isMcpCredentialLiteral(value: string): boolean {
  return value
    .split(/[\s:=/?&#,]+/u)
    .some((candidate) => candidate.length > 0 && SECRET_VALUE_PATTERN.test(candidate));
}

/** A bearer scheme with its token attached, however the argument reached the command line. */
const BEARER_VALUE_PATTERN = /^bearer\s+\S/iu;

/** A name with its value joined on, as in `--api-key=abc` or `DOCS_TOKEN=abc`. */
const INLINE_VALUE_PATTERN = /^(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=(.*)$/su;

/** An HTTP header with its value joined on, as in `Authorization: Bearer abc`. */
const HEADER_VALUE_PATTERN = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(\S[\s\S]*)$/u;

/**
 * Replaces credential-bearing MCP argument values while keeping server-identifying arguments.
 *
 * Four shapes cover how a credential reaches a command line: a value joined to its flag
 * (`--api-key=abc`), a value in the argument after its flag (`--api-key abc`), a header passed
 * whole (`--header "Authorization: Bearer abc"`), and a bare value that is recognizably a token
 * whatever precedes it. A flag never consumes another flag as its value, so a server run with
 * `--token --verbose` keeps the second one.
 */
export function redactMcpArguments(args: readonly string[]): readonly string[] {
  const redacted: string[] = [];
  let afterSecretFlag = false;

  for (const argument of args) {
    redacted.push(redactArgument(argument, afterSecretFlag));
    afterSecretFlag = expectsSecretValue(argument);
  }

  return redacted;
}

/**
 * Removes credentials from an MCP endpoint while preserving its origin, path, and query names.
 *
 * Path segments identify the endpoint and are kept, except ones that announce themselves as
 * credentials — some servers embed the token in the path itself. A token the pattern does not
 * recognize still passes through, so the path is a weaker guarantee than userinfo and query.
 *
 * The query is rebuilt by hand: `URLSearchParams` serializes with the form encoding, which would
 * turn the placeholder into `%5Bredacted%5D`.
 */
export function sanitizeMcpUrl(raw: string): string | undefined {
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
 * What an adapter made of one named configuration entry.
 *
 * There is no "nothing": an entry the adapter cannot turn into a transport is still an entry the
 * user wrote, and the name is what a later write has to reckon with. Returning a reason instead of
 * `undefined` is what keeps it from disappearing.
 */
export type McpEntryParse =
  | { readonly reason: UnusableMcpReason }
  | { readonly transport: McpTransport };

/** Every named entry one configuration file contributed, split by whether Aura can model it. */
export interface McpEntryCollection {
  readonly servers: readonly McpServer[];
  readonly unusable: readonly UnusableMcpServer[];
}

/**
 * Builds the servers an adapter recognizes from the named entries of its configuration.
 *
 * Every adapter reads a differently shaped entry but files the result the same way, so the
 * transport parser stays with the adapter and the bookkeeping lives here.
 */
export function collectMcpServers(
  file: AdapterSourceFile,
  appId: string,
  entries: unknown,
  parseEntry: (candidate: unknown) => McpEntryParse,
): McpEntryCollection {
  if (!isConfigRecord(entries)) {
    return EMPTY_COLLECTION;
  }

  const servers: McpServer[] = [];
  const unusable: UnusableMcpServer[] = [];
  for (const [name, candidate] of Object.entries(entries)) {
    const identity = { appId, name, scope: file.spec.scope, sourceId: file.spec.id };
    const parsed = parseEntry(candidate);
    if ("transport" in parsed) {
      servers.push({ ...identity, transport: parsed.transport });
    } else {
      unusable.push({ ...identity, reason: parsed.reason });
    }
  }
  return { servers, unusable };
}

/** What a file with no `mcpServers` record contributes, shared so the shape is allocated once. */
export const EMPTY_COLLECTION: McpEntryCollection = Object.freeze({
  servers: Object.freeze([]),
  unusable: Object.freeze([]),
});

/** Everything an adapter reads out of one child-process MCP entry, before the model shape. */
export interface StdioTransportFields {
  /** Arguments as configured, already passed through {@link redactMcpArguments}. */
  readonly args: readonly string[];
  readonly command: string;
  readonly environmentVariables: readonly string[];
  readonly inlineCredentialValues: boolean;
}

/**
 * Assembles a stdio transport, omitting every part the entry did not supply.
 *
 * Shared because the omission rules are the model's, not any one application's: two adapters that
 * each spelled them out drifted on which empty value counts as absent.
 */
export function stdioTransport(fields: StdioTransportFields): McpTransport {
  return {
    command: fields.command,
    type: "stdio",
    ...(fields.args.length === 0 ? {} : { args: fields.args }),
    ...(fields.environmentVariables.length === 0
      ? {}
      : { environmentVariables: fields.environmentVariables }),
    ...(fields.inlineCredentialValues ? { inlineCredentialValues: true } : {}),
  };
}

/** Parses configuration text into an object, treating absent and unreadable content alike. */
export function parseConfigObject(
  content: string | undefined,
  parse: (text: string) => unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (content === undefined) {
    return undefined;
  }
  try {
    const value = parse(content);
    return isConfigRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Narrows a parsed configuration value to a plain object. */
export function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads an optional list of strings, distinguishing an omitted field from a malformed one.
 *
 * An absent field is an empty list, so a server that configures nothing still parses; anything
 * that is not a list of strings is `undefined`, which callers treat as an unusable entry.
 */
export function configStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

/** Reads an optional record of strings, with the same absent/malformed split as an array. */
export function configStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isConfigRecord(value)) {
    return undefined;
  }

  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return undefined;
    }
    entries[name] = entry;
  }
  return entries;
}

function redactArgument(argument: string, afterSecretFlag: boolean): string {
  if (afterSecretFlag && !isFlag(argument)) {
    return REDACTED;
  }

  const named = redactNamedValue(argument);
  if (named !== undefined) {
    return named;
  }

  return SECRET_VALUE_PATTERN.test(argument) || BEARER_VALUE_PATTERN.test(argument)
    ? REDACTED
    : argument;
}

/** Redacts a value joined to its own name, keeping the name so the argument stays readable. */
function redactNamedValue(argument: string): string | undefined {
  const inlineName = INLINE_VALUE_PATTERN.exec(argument)?.[1];
  if (inlineName !== undefined && isSecretName(inlineName)) {
    return `${inlineName}=${REDACTED}`;
  }

  const headerName = HEADER_VALUE_PATTERN.exec(argument)?.[1];
  return headerName !== undefined && isSecretName(headerName)
    ? `${headerName}: ${REDACTED}`
    : undefined;
}

function expectsSecretValue(argument: string): boolean {
  return isFlag(argument) && !INLINE_VALUE_PATTERN.test(argument) && isSecretName(argument);
}

function isFlag(argument: string): boolean {
  return argument.startsWith("-");
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name.replace(/^-+/u, ""));
}
