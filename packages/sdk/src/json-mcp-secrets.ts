import { URL } from "node:url";

import { isMcpSecretValue } from "./mcp-secret-heuristics.js";
import type {
  McpSecretLocator,
  McpSecretRedaction,
  McpSecretSighting,
  McpSecretTransform,
  McpSecretTransformInput,
} from "./mcp-secret.js";

const REDACTED = "[redacted]";

/** Creates whole-file JSON remediation and redaction using an application's reference syntax. */
export function jsonMcpSecretTransform(
  reference: (name: string) => string,
  variablePattern: RegExp,
): McpSecretTransform {
  return {
    redact: (input) => redactJson(input, variablePattern),
    rewrite: (input) => {
      const transformed = transformJson(input, (sighting) => reference(sighting.suggestedEnvName));
      return transformed ?? { refusal: "The MCP configuration is not a JSON object." };
    },
    supports: () => true,
  };
}

/**
 * Masks every located sighting, then sweeps the rest of the document for credential-shaped values.
 *
 * The sweep is what covers the fields no sighting names. A shared configuration file holds more
 * than the scanned directory's servers — `~/.claude.json` carries an entry per project the user
 * has ever opened — and a diff hunk can reach lines the scan never inspected.
 */
function redactJson(
  input: McpSecretTransformInput,
  variablePattern: RegExp,
): McpSecretRedaction | undefined {
  const root = parseRoot(input.content);
  if (root === undefined) {
    return undefined;
  }

  const unresolved: string[] = [];
  for (const sighting of input.sightings) {
    const entry = serverEntry(root, sighting);
    if (entry === undefined) {
      unresolved.push(sighting.field);
      continue;
    }
    replaceSighting(entry, sighting.locator, REDACTED, variablePattern);
  }
  maskResidualSecrets(root);
  return { content: stringifyLike(input.content, root), unresolved };
}

function transformJson(
  input: McpSecretTransformInput,
  replacement: (sighting: McpSecretSighting) => string,
): { readonly content: string; readonly rewrittenFields: readonly string[] } | undefined {
  const root = parseRoot(input.content);
  if (root === undefined) {
    return undefined;
  }

  const rewrittenFields: string[] = [];
  for (const sighting of input.sightings) {
    const entry = serverEntry(root, sighting);
    if (entry === undefined) {
      continue;
    }
    if (replaceSighting(entry, sighting.locator, replacement(sighting), undefined)) {
      rewrittenFields.push(sighting.field);
    }
  }
  return { content: stringifyLike(input.content, root), rewrittenFields };
}

function parseRoot(content: string): Record<string, unknown> | undefined {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch {
    return undefined;
  }
  return isMutableRecord(root) ? root : undefined;
}

/** Replaces every credential-shaped string anywhere in the document, whatever field holds it. */
function maskResidualSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry === "string" && isMcpSecretValue(entry)) {
        value[index] = REDACTED;
      } else {
        maskResidualSecrets(entry);
      }
    }
    return;
  }
  if (!isMutableRecord(value)) {
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string" && isMcpSecretValue(entry)) {
      value[name] = REDACTED;
    } else {
      maskResidualSecrets(entry);
    }
  }
}

function serverEntry(
  root: Record<string, unknown>,
  sighting: McpSecretSighting,
): Record<string, unknown> | undefined {
  let current: unknown = root;
  for (const segment of sighting.recordPath) {
    if (!isMutableRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  if (!isMutableRecord(current)) {
    return undefined;
  }
  const entry = current[sighting.serverName];
  return isMutableRecord(entry) ? entry : undefined;
}

function replaceSighting(
  entry: Record<string, unknown>,
  locator: McpSecretLocator,
  replacement: string,
  skipReferences: RegExp | undefined,
): boolean {
  if (skipReferences !== undefined && locatorHoldsReference(entry, locator, skipReferences)) {
    return false;
  }
  switch (locator.kind) {
    case "arg":
      return replaceArgument(entry, locator.index, replacement);
    case "env":
      return replaceRecordValue(entry, "env", locator.name, replacement, false);
    case "header":
      return replaceRecordValue(entry, "headers", locator.name, replacement, true);
    case "url-path":
    case "url-query":
    case "url-userinfo":
      return replaceUrl(entry, locator, replacement);
  }
}

function locatorHoldsReference(
  entry: Record<string, unknown>,
  locator: McpSecretLocator,
  pattern: RegExp,
): boolean {
  const value = locatorValue(entry, locator);
  if (typeof value !== "string") {
    return false;
  }
  pattern.lastIndex = 0;
  const remaining = value
    .replaceAll(pattern, "")
    .replace(/^\s*bearer\b/iu, "")
    .trim();
  pattern.lastIndex = 0;
  return remaining.length === 0;
}

function locatorValue(entry: Record<string, unknown>, locator: McpSecretLocator): unknown {
  if (locator.kind === "arg") {
    const args = entry["args"];
    return Array.isArray(args) ? args[locator.index] : undefined;
  }
  if (locator.kind === "env" || locator.kind === "header") {
    const record = entry[locator.kind === "env" ? "env" : "headers"];
    return isMutableRecord(record) ? record[locator.name] : undefined;
  }
  return undefined;
}

// fallow-ignore-next-line complexity -- preserves joined names and bearer/header schemes across argument shapes.
function replaceArgument(
  entry: Record<string, unknown>,
  index: number,
  replacement: string,
): boolean {
  const args = entry["args"];
  if (!Array.isArray(args) || typeof args[index] !== "string") {
    return false;
  }
  const current = args[index];
  const joined = /^(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=(.*)$/su.exec(current);
  if (joined?.[1] !== undefined) {
    args[index] = `${joined[1]}=${replacement}`;
    return true;
  }
  const header = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(\S[\s\S]*)$/u.exec(current);
  if (header?.[1] !== undefined) {
    const scheme = /^\s*bearer\s+/iu.test(header[2] ?? "") ? "Bearer " : "";
    args[index] = `${header[1]}: ${scheme}${replacement}`;
    return true;
  }
  args[index] = /^\s*bearer\s+/iu.test(current) ? `Bearer ${replacement}` : replacement;
  return true;
}

function replaceRecordValue(
  entry: Record<string, unknown>,
  key: string,
  name: string,
  replacement: string,
  preserveBearer: boolean,
): boolean {
  const record = entry[key];
  if (!isMutableRecord(record) || typeof record[name] !== "string") {
    return false;
  }
  const bearer = preserveBearer && /^\s*bearer\s+/iu.test(record[name]);
  record[name] = bearer ? `Bearer ${replacement}` : replacement;
  return true;
}

function replaceUrl(
  entry: Record<string, unknown>,
  locator: Extract<McpSecretLocator, { readonly kind: `url-${string}` }>,
  replacement: string,
): boolean {
  const raw = entry["url"];
  if (typeof raw !== "string") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (locator.kind === "url-userinfo") {
    url[locator.component] = replacement;
  } else if (locator.kind === "url-query") {
    const values = url.searchParams.getAll(locator.name);
    if (values.length === 0) {
      return false;
    }
    url.searchParams.delete(locator.name);
    for (const unused of values) {
      void unused;
      url.searchParams.append(locator.name, replacement);
    }
  } else {
    const segments = url.pathname.split("/");
    if (segments[locator.index] === undefined) {
      return false;
    }
    segments[locator.index] = replacement;
    url.pathname = segments.join("/");
  }
  entry["url"] = restoreReferenceEncoding(url.toString(), replacement);
  return true;
}

function restoreReferenceEncoding(value: string, replacement: string): string {
  return value
    .replaceAll(encodeURIComponent(replacement), replacement)
    .replaceAll(encodeURIComponent(replacement).replaceAll("%20", "+"), replacement);
}

function stringifyLike(original: string, value: Readonly<Record<string, unknown>>): string {
  const indent = /\n([ \t]+)\S/u.exec(original)?.[1] ?? "  ";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /(?:\r?\n)$/u.test(original);
  const rendered = JSON.stringify(value, undefined, indent).replaceAll("\n", eol);
  return trailing ? `${rendered}${eol}` : rendered;
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
