/**
 * Locating a Codex MCP field in the source text that produced it.
 *
 * `smol-toml` resolves a document into values, which is what parsing needs and what detection runs
 * on. Masking a value in place needs its byte range instead, and a resolved value has forgotten
 * where it came from — hence the second parser. Every lookup here has to agree with what `smol-toml`
 * resolved, because a field detection can see and this module cannot is a field that survives
 * redaction: TOML spells the same entry as a standalone table, an inline table, or dotted keys, and
 * matching only the first shape is what leaks the other two.
 */
import type { AST } from "toml-eslint-parser";

import type { McpSecretLocator } from "@tryaura/aura-sdk";

/** One key/value node under a server entry, with its key path relative to that entry. */
export interface TomlServerField {
  readonly node: AST.TOMLKeyValue;
  readonly path: readonly string[];
}

const SERVERS_KEY = "mcp_servers";

/** The standalone `[mcp_servers.<name>]` table, which is the only shape a rewrite can edit. */
export function findServerTable(
  ast: AST.TOMLProgram,
  serverName: string,
): AST.TOMLTable | undefined {
  return findTable(ast, [SERVERS_KEY, serverName]);
}

export function findTable(
  ast: AST.TOMLProgram,
  path: readonly string[],
): AST.TOMLTable | undefined {
  return topLevelBody(ast).find(
    (node): node is AST.TOMLTable =>
      node.type === "TOMLTable" &&
      node.resolvedKey.length === path.length &&
      node.resolvedKey.every((segment, index) => String(segment) === path[index]),
  );
}

/** Every field of one server entry, whatever shape the document spells that entry in. */
export function serverFields(ast: AST.TOMLProgram, serverName: string): readonly TomlServerField[] {
  const prefix = [SERVERS_KEY, serverName];
  const fields: TomlServerField[] = [];
  for (const node of topLevelBody(ast)) {
    const container = node.type === "TOMLTable" ? node.resolvedKey.map(String) : [];
    const children = node.type === "TOMLTable" ? node.body : [node];
    for (const child of children) {
      const path = relativeTo([...container, ...keyPath(child)], prefix);
      if (path !== undefined) {
        collectField(fields, path, child);
      }
    }
  }
  return fields;
}

/** The node holding the value a locator names, or `undefined` when the document has no such field. */
export function locatorValueNode(
  ast: AST.TOMLProgram,
  serverName: string,
  locator: McpSecretLocator,
): AST.TOMLContentNode | undefined {
  const fields = serverFields(ast, serverName);
  if (locator.kind === "arg") {
    const args = fieldAt(fields, ["args"]);
    return args?.type === "TOMLArray" ? args.elements[locator.index] : undefined;
  }
  if (locator.kind === "env") {
    return fieldAt(fields, ["env", locator.name]);
  }
  if (locator.kind === "header") {
    return fieldAt(fields, ["http_headers", locator.name]);
  }
  // Every URL locator addresses part of one string, so the whole string is what gets masked.
  return fieldAt(fields, ["url"]);
}

export function findKeyValue(
  table: AST.TOMLTable | undefined,
  path: readonly string[],
): AST.TOMLKeyValue | undefined {
  return table === undefined ? undefined : findKeyValueIn(table.body, path);
}

function findKeyValueIn(
  body: readonly AST.TOMLKeyValue[],
  path: readonly string[],
): AST.TOMLKeyValue | undefined {
  return body.find((node) => samePath(keyPath(node), path));
}

export function keyPath(node: AST.TOMLKeyValue): readonly string[] {
  return node.key.keys.map((key) => (key.type === "TOMLBare" ? key.name : String(key.value)));
}

function topLevelBody(ast: AST.TOMLProgram): readonly (AST.TOMLKeyValue | AST.TOMLTable)[] {
  return ast.body[0]?.body ?? [];
}

function fieldAt(
  fields: readonly TomlServerField[],
  path: readonly string[],
): AST.TOMLContentNode | undefined {
  return fields.find((field) => samePath(field.path, path))?.node.value;
}

/** Records the field and, when it holds an inline table, every field nested inside it. */
function collectField(
  fields: TomlServerField[],
  path: readonly string[],
  node: AST.TOMLKeyValue,
): void {
  fields.push({ node, path });
  if (node.value.type !== "TOMLInlineTable") {
    return;
  }
  for (const child of node.value.body) {
    collectField(fields, [...path, ...keyPath(child)], child);
  }
}

function relativeTo(
  absolute: readonly string[],
  prefix: readonly string[],
): readonly string[] | undefined {
  if (absolute.length < prefix.length) {
    return undefined;
  }
  return prefix.every((segment, index) => absolute[index] === segment)
    ? absolute.slice(prefix.length)
    : undefined;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
