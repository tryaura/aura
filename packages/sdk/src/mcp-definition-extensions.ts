import { isMcpCredentialLiteral } from "./mcp.js";
import type { McpDefinitionError } from "./mcp-definition-types.js";
import { isMcpDefinitionRecord, jsonPropertyPath } from "./mcp-definition-values.js";

/** The fields each transport kind defines, and which the branch parsers validate in full. */
const STDIO_TRANSPORT_FIELDS: ReadonlySet<string> = new Set(["args", "command", "env", "type"]);
const HTTP_TRANSPORT_FIELDS: ReadonlySet<string> = new Set(["headers", "type", "url"]);

/**
 * Rejects the transport fields a stored definition may not carry beyond the ones it declares.
 *
 * A transport keeps fields this release does not define so a manifest written by a newer Aura
 * survives a round-trip through an older one. That preservation is what makes this check load
 * bearing: without it, `{"type": "stdio", "headers": {"Authorization": "Bearer <token>"}}` would
 * carry a credential past the branch parser — the `http` parser validates `headers`, and the
 * `stdio` parser never looks at them. Fields belonging to the other transport are refused outright,
 * and everything left is scanned for credential literals before it is allowed through.
 */
export function transportExtensionProblem(
  source: Readonly<Record<string, unknown>>,
  path: string,
  type: "http" | "stdio",
): McpDefinitionError | undefined {
  const own = type === "stdio" ? STDIO_TRANSPORT_FIELDS : HTTP_TRANSPORT_FIELDS;
  const foreign = type === "stdio" ? HTTP_TRANSPORT_FIELDS : STDIO_TRANSPORT_FIELDS;

  for (const [key, value] of Object.entries(source)) {
    if (own.has(key)) {
      continue;
    }
    const fieldPath = jsonPropertyPath(path, key);
    if (foreign.has(key)) {
      return Object.freeze({ message: `must not appear on a ${type} transport`, path: fieldPath });
    }
    const credential = credentialProblem(value, fieldPath);
    if (credential !== undefined) {
      return credential;
    }
  }
  return undefined;
}

/**
 * Finds the first recognizable credential anywhere inside one extension field.
 *
 * Walked with an explicit stack rather than recursively: the value comes from a file, and a few
 * kilobytes of `[` would otherwise overflow on the way back out. A `RangeError` is not one of the
 * failures a definition can degrade into, so it would escape as an exception.
 */
function credentialProblem(value: unknown, path: string): McpDefinitionError | undefined {
  const pending: Addressed[] = [{ path, value }];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) {
      break;
    }
    if (typeof entry.value !== "string") {
      pending.push(...members(entry));
      continue;
    }
    if (isMcpCredentialLiteral(entry.value)) {
      return Object.freeze({ message: "must not contain a credential literal", path: entry.path });
    }
  }
  return undefined;
}

/** One value the walk still has to look at, and the path that names it. */
interface Addressed {
  readonly path: string;
  readonly value: unknown;
}

/** The addressable values one level inside `entry`, or none for a leaf. */
function members(entry: Addressed): readonly Addressed[] {
  if (Array.isArray(entry.value)) {
    return entry.value.map((item, index) => ({
      path: `${entry.path}[${String(index)}]`,
      value: item,
    }));
  }
  if (isMcpDefinitionRecord(entry.value)) {
    return Object.entries(entry.value).map(([key, item]) => ({
      path: jsonPropertyPath(entry.path, key),
      value: item,
    }));
  }
  return [];
}
