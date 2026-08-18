import {
  isConfigRecord,
  McpWriteError,
  mcpCommandEntry,
  mcpWriteResult,
  type McpWrite,
  type OwnedServerEntry,
} from "@tryaura/aura-sdk";
import { parse, stringify } from "smol-toml";

import { MANAGED_BEGIN, MANAGED_END, replaceManagedSection } from "./toml-section.js";

/** Replaces Aura's marker-delimited Codex MCP section and validates the complete TOML result. */
export const writeMcpServers: McpWrite = ({ desired, existingContent, ledgerNames }) =>
  mcpWriteResult(() => {
    const existing = existingContent ?? "";
    validateToml(existing, "Codex's existing configuration is not valid TOML.");
    const section = managedSection(desired);
    const merged = replaceManagedSection(existing, section);
    assertUnmanagedNamesFree(existing, desired, ledgerNames);
    validateToml(merged, "The generated Codex MCP configuration is not valid TOML.");
    return merged;
  });

/**
 * Refuses names Aura would write or drop that are declared outside its managed section.
 *
 * Regenerating the marker-delimited block cannot reach a `[mcp_servers.x]` table someone wrote
 * elsewhere in the file. Left alone, a ledger name outside the markers survives a removal Aura
 * reports as done, and a desired name outside them becomes a duplicate key. Both are refusals: the
 * writer edits its own section and says so rather than rewriting hand-authored TOML.
 */
function assertUnmanagedNamesFree(
  existing: string,
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
): void {
  const unmanaged = unmanagedServerNames(existing);
  if (unmanaged.size === 0) {
    return;
  }
  const claimed = [...new Set([...ledgerNames, ...desired.map((entry) => entry.name)])];
  const collision = claimed.find((name) => unmanaged.has(name));
  if (collision !== undefined) {
    throw new McpWriteError(
      `MCP server ${collision} is declared outside Aura's managed Codex section and was left unchanged.`,
    );
  }
}

function unmanagedServerNames(existing: string): ReadonlySet<string> {
  const withoutManaged = replaceManagedSection(existing, "");
  let root: unknown;
  try {
    root = parse(withoutManaged);
  } catch {
    return new Set();
  }
  const servers = isConfigRecord(root) ? root["mcp_servers"] : undefined;
  return new Set(isConfigRecord(servers) ? Object.keys(servers) : []);
}

function managedSection(desired: readonly OwnedServerEntry[]): string {
  if (desired.length === 0) {
    return "";
  }
  const servers: Record<string, unknown> = {};
  for (const entry of desired) {
    servers[entry.name] = codexEntry(entry);
  }
  const generated = stringify({ mcp_servers: servers }).trimEnd();
  validateToml(generated, "The generated Codex MCP section is not valid TOML.");
  return `${MANAGED_BEGIN}\n${generated}\n${MANAGED_END}`;
}

function codexEntry(entry: OwnedServerEntry): Readonly<Record<string, unknown>> {
  if (entry.transport.type === "stdio") {
    return {
      ...mcpCommandEntry(entry.transport),
      ...(entry.transport.env === undefined ? {} : { env_vars: entry.transport.env }),
    };
  }

  const headers = codexHeaders(entry.transport.headers ?? {});
  return {
    url: entry.transport.url,
    ...(headers.bearer === undefined ? {} : { bearer_token_env_var: headers.bearer }),
    ...(Object.keys(headers.environment).length === 0
      ? {}
      : { env_http_headers: headers.environment }),
  };
}

function codexHeaders(headers: Readonly<Record<string, string>>): {
  readonly bearer?: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
} {
  let bearer: string | undefined;
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const direct = /^\$\{(?<name>[A-Z_][A-Z0-9_]*)\}$/u.exec(value)?.groups?.["name"];
    const authorization = /^Bearer \$\{(?<name>[A-Z_][A-Z0-9_]*)\}$/iu.exec(value)?.groups?.[
      "name"
    ];
    if (name.toLowerCase() === "authorization" && authorization !== undefined) {
      if (bearer !== undefined) {
        throw new McpWriteError("Codex cannot represent more than one bearer-token header.");
      }
      bearer = authorization;
      continue;
    }
    if (direct === undefined) {
      throw new McpWriteError(
        `Codex cannot represent the manifest template for HTTP header ${name}.`,
      );
    }
    environment[name] = direct;
  }
  return { ...(bearer === undefined ? {} : { bearer }), environment };
}

function validateToml(content: string, message: string): void {
  if (content.length === 0) {
    return;
  }
  try {
    parse(content);
  } catch {
    throw new McpWriteError(message);
  }
}
