import { defineOwnProperty } from "./mcp-definition-values.js";
import { isConfigRecord } from "./mcp.js";
import {
  McpWriteError,
  mcpCommandEntry,
  mcpWriteResult,
  type McpWriteInput,
  type McpWriteResult,
  type OwnedServerEntry,
} from "./mcp-write.js";

/** Converts one desired server into an application's JSON entry shape. */
export type JsonMcpEntryWriter = (entry: OwnedServerEntry) => Readonly<Record<string, unknown>>;

/** Converts one desired definition to the shared JSON shape with application-specific variables. */
export function jsonMcpEntry(
  entry: OwnedServerEntry,
  formatVariable: (name: string) => string,
): Readonly<Record<string, unknown>> {
  if (entry.transport.type === "stdio") {
    return {
      ...mcpCommandEntry(entry.transport),
      ...(entry.transport.env === undefined
        ? {}
        : {
            env: Object.fromEntries(
              entry.transport.env.map((name) => [name, formatVariable(name)]),
            ),
          }),
    };
  }
  return {
    type: "http",
    url: entry.transport.url,
    ...(entry.transport.headers === undefined
      ? {}
      : {
          headers: Object.fromEntries(
            Object.entries(entry.transport.headers).map(([name, value]) => [
              name,
              value.replaceAll(/\$\{([A-Z_][A-Z0-9_]*)\}/gu, (_match, variable: string) =>
                formatVariable(variable),
              ),
            ]),
          ),
        }),
  };
}

/** Safely rewrites the common top-level JSON `mcpServers` record. */
export function writeJsonMcpServers(
  input: McpWriteInput,
  writeEntry: JsonMcpEntryWriter,
): McpWriteResult {
  return mcpWriteResult(() => renderJsonMcpServers(input, writeEntry));
}

function renderJsonMcpServers(
  { desired, existingContent, ledgerNames }: McpWriteInput,
  writeEntry: JsonMcpEntryWriter,
): string {
  const root = parseRoot(existingContent);
  const existingServers = existingServerRecord(root);
  const servers = mergedServers(existingServers, desired, ledgerNames, writeEntry);

  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(root)) {
    defineOwnProperty(output, name, value);
  }
  if (existingServers !== undefined || desired.length > 0) {
    defineOwnProperty(output, "mcpServers", servers);
  }

  const style = jsonStyle(existingContent);
  const serialized = JSON.stringify(output, undefined, style.indent).replaceAll("\n", style.eol);
  return serialized + (style.trailingNewline ? style.eol : "");
}

function existingServerRecord(
  root: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const existing = root["mcpServers"];
  if (existing === undefined) {
    return undefined;
  }
  if (!isConfigRecord(existing)) {
    throw new McpWriteError("The existing mcpServers value is not a JSON object.");
  }
  return existing;
}

/**
 * Applies the desired servers over the ones already there.
 *
 * Ledger names come out first, so a name Aura owns is replaced rather than compared against itself,
 * and any name still standing afterwards belongs to the user.
 */
function mergedServers(
  existing: Readonly<Record<string, unknown>> | undefined,
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
  writeEntry: JsonMcpEntryWriter,
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(existing ?? {})) {
    defineOwnProperty(servers, name, value);
  }
  const ledger = new Set(ledgerNames);
  for (const name of ledger) {
    delete servers[name];
  }
  for (const entry of desired) {
    if (Object.hasOwn(servers, entry.name)) {
      throw new McpWriteError(
        `MCP server ${entry.name} exists outside Aura's ownership ledger and was left unchanged.`,
      );
    }
    defineOwnProperty(servers, entry.name, writeEntry(entry));
  }
  return servers;
}

function parseRoot(content: string | undefined): Readonly<Record<string, unknown>> {
  if (content === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (isConfigRecord(parsed)) {
      return parsed;
    }
  } catch {
    // The safe refusal below deliberately does not quote parser text or source contents.
  }
  throw new McpWriteError("The existing MCP configuration is not a valid JSON object.");
}

/**
 * Reproduces the formatting of the document being edited.
 *
 * A file with no line break was written compact, and re-indenting one is not an edit to the MCP
 * section — it rewrites every byte of a document Aura was asked to make one change to.
 */
function jsonStyle(content: string | undefined): {
  readonly eol: "\n" | "\r\n";
  readonly indent: string;
  readonly trailingNewline: boolean;
} {
  if (content === undefined) {
    return { eol: "\n", indent: "  ", trailingNewline: true };
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = content.endsWith("\n");
  const secondLine = content
    .split(/\r?\n/u)
    .slice(1)
    .find((line) => line.trim().length > 0);
  if (secondLine === undefined) {
    return { eol, indent: "", trailingNewline };
  }
  return {
    eol,
    indent: /^(?<indent>\s+)["}]/u.exec(secondLine)?.groups?.["indent"] ?? "  ",
    trailingNewline,
  };
}
