import type {
  AuraTeamPreset,
  DirectorySkillSource,
  McpServerDefinition,
  McpServerManifest,
  RepoContentSet,
} from "@tryaura/aura-sdk";
import { Buffer } from "node:buffer";

import { safe } from "../safe-text.js";

/** Printed instead of the row block when the preset carries nothing worth reviewing. */
const NO_SETTINGS = "No check, MCP, skill, or snippet settings.";

/** One aligned line: a short kind term and everything the reviewer needs about that entity. */
interface PreviewRow {
  readonly detail: string;
  readonly term: string;
}

/**
 * Security-relevant capabilities shown before repository-controlled settings are accepted.
 *
 * One row per thing, never one row per field: a snippet the preset both provides and selects is
 * one snippet, and naming it twice made the screen long enough to skim past. Everything
 * executable-adjacent is spelled out verbatim (escaped) — the MCP command line or endpoint is
 * exactly what a later selection would configure, and trust time is the one moment the user is
 * looking. Snippet bodies are deliberately not echoed — pasting untrusted Markdown into a consent
 * prompt is its own injection surface — the picker's preview is where they are read, and the
 * prompt itself carries the explicit-selection boundary.
 */
export function repoPresetTrustPreview(
  preset: AuraTeamPreset,
  contentSet: RepoContentSet | undefined,
): string {
  const rows = [
    ...mcpRows(preset, contentSet),
    ...skillRows(preset, contentSet),
    ...snippetRows(preset, contentSet),
    ...(preset.skillDirectories ?? []).map(directoryRow),
    ...listRow("sources", preset.allowedSkillSources),
    ...checksRow(preset.checks),
  ];
  // Blank lines top and bottom: the block is a table between two sentences, not more prose.
  return ["", ...(rows.length === 0 ? [`  ${NO_SETTINGS}`] : alignRows(rows)), ""].join("\n");
}

/** Whether the prompt should promise that admitted content still needs a deliberate tick. */
export function hasRepoContent(contentSet: RepoContentSet | undefined): boolean {
  return (
    contentSet !== undefined &&
    contentSet.mcpServers.length + contentSet.skills.length + contentSet.snippets.length > 0
  );
}

function alignRows(rows: readonly PreviewRow[]): readonly string[] {
  const width = Math.max(...rows.map((row) => row.term.length));
  return rows.map((row) => `  ${row.term.padEnd(width)}  ${row.detail}`);
}

/**
 * Every MCP server the repository would configure, provided ones with their full command line.
 *
 * A required id the repository does not define itself resolves from the catalog, so it gets a row
 * saying that rather than an executable surface this file cannot promise.
 */
function mcpRows(preset: AuraTeamPreset, contentSet: RepoContentSet | undefined): PreviewRow[] {
  const provided = contentSet?.mcpServers ?? [];
  const providedIds = new Set(provided.map((server) => server.id));
  const required = new Set(preset.requiredMcpServers ?? []);
  return [
    ...provided.map((server) => ({
      detail: `${mcpServerPreview(server)}${required.has(server.id) ? " · required" : ""}`,
      term: "mcp",
    })),
    ...[...required]
      .filter((id) => !providedIds.has(id))
      .map((id) => ({ detail: `${safe(id)} · required, from the catalog`, term: "mcp" })),
  ];
}

/** Skill trees the repository ships, then selections that point somewhere else. */
function skillRows(preset: AuraTeamPreset, contentSet: RepoContentSet | undefined): PreviewRow[] {
  const provided = contentSet?.skills ?? [];
  const providedKeys = new Set(provided.map((skill) => `${skill.source.id}/${skill.id}`));
  return [
    ...provided.map((skill) => ({
      detail: `${safe(skill.id)} (${count(skill.files.length, "file")})`,
      term: "skill",
    })),
    ...(preset.skills ?? [])
      .map((selection) => `${selection.source}/${selection.id}`)
      .filter((key) => !providedKeys.has(key))
      .map((key) => ({ detail: `${safe(key)} · selected`, term: "skill" })),
  ];
}

/** Snippets the repository ships, then selections from the catalog. */
function snippetRows(preset: AuraTeamPreset, contentSet: RepoContentSet | undefined): PreviewRow[] {
  const provided = contentSet?.snippets ?? [];
  const providedIds = new Set(provided.map((snippet) => snippet.id));
  return [
    ...provided.map((snippet) => ({
      detail: `${safe(snippet.id)} (${String(Buffer.byteLength(snippet.body, "utf8"))} B)`,
      term: "snippet",
    })),
    ...(preset.snippets ?? [])
      .filter((id) => !providedIds.has(id))
      .map((id) => ({ detail: `${safe(id)} · selected`, term: "snippet" })),
  ];
}

/** The full executable surface of one provided MCP server, escaped but verbatim. */
function mcpServerPreview(server: McpServerManifest): string {
  return `${safe(server.id)} "${safe(server.serverName)}" → ${transportPreview(server.transportTemplate)}`;
}

function transportPreview(transport: McpServerDefinition): string {
  if (transport.type === "http") {
    return `http ${safe(transport.url)}`;
  }
  const args = (transport.args ?? []).map((argument) => `"${safe(argument)}"`).join(", ");
  const env = (transport.env ?? []).map(safe).join(", ");
  return [
    `stdio "${safe(transport.command)}"`,
    ...(args === "" ? [] : [`args [${args}]`]),
    ...(env === "" ? [] : [`env ${env}`]),
  ].join(", ");
}

/** The exact check settings the repository preset asks the user to trust. */
function checksRow(checks: AuraTeamPreset["checks"]): readonly PreviewRow[] {
  if (checks === undefined) {
    return [];
  }
  const settings = [
    ...(checks.disabled ?? []).map((id) => `${safe(id)}: disabled`),
    ...(checks.enabled ?? []).map((id) => `${safe(id)}: enabled`),
    ...Object.entries(checks.severity ?? {}).map(
      ([id, severity]) => `${safe(id)}: severity ${safe(severity)}`,
    ),
    ...Object.entries(checks.thresholds ?? {}).map(
      ([id, thresholds]) => `${safe(id)}: thresholds ${safe(JSON.stringify(thresholds))}`,
    ),
  ].sort();
  return [{ detail: settings.length === 0 ? "(none)" : settings.join("; "), term: "checks" }];
}

function directoryRow(source: DirectorySkillSource): PreviewRow {
  const token = source.kind === "private-directory" ? ` · token ${safe(source.tokenEnv)}` : "";
  return { detail: `${safe(source.name)} → ${safe(source.url)}${token}`, term: "directory" };
}

function listRow(term: string, values: readonly string[] | undefined): readonly PreviewRow[] {
  if (values === undefined) {
    return [];
  }
  return [{ detail: values.length === 0 ? "(none)" : values.map(safe).join(", "), term }];
}

function count(total: number, noun: string): string {
  return `${String(total)} ${noun}${total === 1 ? "" : "s"}`;
}
