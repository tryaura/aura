import { URL } from "node:url";

import {
  isEnvironmentReference,
  isEnvironmentVariableName,
  isMcpSecretName,
  isMcpSecretValue,
} from "./mcp-secret-heuristics.js";
import { nameSightings } from "./mcp-secret-name.js";
import type {
  McpSecretInspectionContext,
  McpSecretSighting,
  McpSecretSightingDraft,
} from "./mcp-secret.js";

const INLINE_VALUE_PATTERN = /^(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=(.*)$/su;
const HEADER_VALUE_PATTERN = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(\S[\s\S]*)$/u;

/** Collects safe sightings from every known field of a JSON-shaped MCP entry. */
export function inspectJsonMcpSecrets(
  candidate: unknown,
  context: McpSecretInspectionContext,
): readonly McpSecretSighting[] {
  if (!isConfigRecord(candidate)) {
    return [];
  }
  if (!context.variablePattern.global) {
    throw new TypeError("McpSecretInspectionContext.variablePattern must carry the g flag.");
  }

  const drafts: McpSecretSightingDraft[] = [];
  inspectRecord(candidate["env"], "env", context, drafts);
  inspectArguments(candidate["args"], context, drafts);
  inspectUrl(candidate["url"], context, drafts);
  inspectRecord(candidate["headers"], "headers", context, drafts);
  return nameSightings(drafts);
}

// fallow-ignore-next-line complexity -- field-name and value heuristics converge here without retaining values.
function inspectRecord(
  value: unknown,
  kind: "env" | "headers",
  context: McpSecretInspectionContext,
  drafts: McpSecretSightingDraft[],
): void {
  if (!isConfigRecord(value)) {
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || isEnvironmentReference(entry, context.variablePattern)) {
      continue;
    }
    const withoutScheme = entry.replace(/^\s*bearer\s+/iu, "").trim();
    if (!isMcpSecretName(name) && !isMcpSecretValue(withoutScheme)) {
      continue;
    }
    drafts.push({
      context,
      field: `${kind}.${name}`,
      locator: kind === "env" ? { kind: "env", name } : { kind: "header", name },
      ...(kind === "env" && isEnvironmentVariableName(name) ? { preferredEnvName: name } : {}),
    });
  }
}

// fallow-ignore-next-line complexity -- command-line secret shapes share ordering state for separate flag values.
function inspectArguments(
  value: unknown,
  context: McpSecretInspectionContext,
  drafts: McpSecretSightingDraft[],
): void {
  if (!Array.isArray(value)) {
    return;
  }
  let afterSecretFlag = false;
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      afterSecretFlag = false;
      continue;
    }
    const named = INLINE_VALUE_PATTERN.exec(entry);
    const header = HEADER_VALUE_PATTERN.exec(entry);
    const namedSecret = named !== null && isMcpSecretName(named[1] ?? "");
    const headerSecret = header !== null && isMcpSecretName(header[1] ?? "");
    const candidate = named?.[2] ?? header?.[2]?.replace(/^\s*bearer\s+/iu, "") ?? entry;
    if (
      !isEnvironmentReference(candidate, context.variablePattern) &&
      ((afterSecretFlag && !entry.startsWith("-")) ||
        namedSecret ||
        headerSecret ||
        isMcpSecretValue(candidate))
    ) {
      drafts.push({
        context,
        field: `args[${index}]`,
        locator: { index, kind: "arg" },
      });
    }
    afterSecretFlag = entry.startsWith("-") && named === null && isMcpSecretName(entry);
  }
}

// fallow-ignore-next-line complexity -- URL components have distinct safe locators and reference rules.
function inspectUrl(
  value: unknown,
  context: McpSecretInspectionContext,
  drafts: McpSecretSightingDraft[],
): void {
  if (typeof value !== "string") {
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  for (const component of ["username", "password"] as const) {
    const entry = url[component];
    if (
      entry.length > 0 &&
      !isEnvironmentReference(decodeUrlComponent(entry), context.variablePattern)
    ) {
      drafts.push({
        context,
        field: `url.${component}`,
        locator: { component, kind: "url-userinfo" },
      });
    }
  }
  const queryNames = new Set<string>();
  for (const [name, entry] of url.searchParams) {
    if (
      !queryNames.has(name) &&
      !isEnvironmentReference(entry, context.variablePattern) &&
      (isMcpSecretName(name) || isMcpSecretValue(entry))
    ) {
      queryNames.add(name);
      drafts.push({
        context,
        field: `url.query.${name}`,
        locator: { kind: "url-query", name },
      });
    }
  }
  const segments = url.pathname.split("/");
  for (const [index, segment] of segments.entries()) {
    const decoded = decodeUrlComponent(segment);
    if (
      segment.length > 0 &&
      !isEnvironmentReference(decoded, context.variablePattern) &&
      isMcpSecretValue(decoded)
    ) {
      drafts.push({
        context,
        field: `url.path[${index}]`,
        locator: { index, kind: "url-path" },
      });
    }
  }
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
