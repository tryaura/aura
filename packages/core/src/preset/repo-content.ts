import { Buffer } from "node:buffer";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AuraTeamPreset,
  McpServerManifest,
  RepoContentSet,
  ResolvedMcpServerDef,
} from "@tryaura/aura-sdk";

import { hashContent } from "../content-hash.js";
import { resolveRepoSkills } from "../skills/repo-source.js";
import type { ScanDiagnostic } from "../workspace/diagnostics.js";
import type { FileReader } from "../workspace/reader.js";
import { readRepoSnippets } from "./repo-content-files.js";
import { MAX_REPO_CONTENT_TOTAL_BYTES } from "./repo-content-limits.js";

const REPO_CONTENT_DIAGNOSTIC_ID = "core/repo-content";

/** The repository content set as read for one run, or why it cannot be used. */
export type RepoContentResult =
  | {
      readonly contentSet: RepoContentSet;
      readonly diagnostics: readonly ScanDiagnostic[];
      /** The composite trust hash covering the preset text and every snippet body. */
      readonly hash: string;
      readonly status: "ready";
    }
  | { readonly diagnostics: readonly ScanDiagnostic[]; readonly status: "invalid" };

/** Selects which repository-authored content a command needs in its snapshot. */
export interface RepoContentReadOptions {
  /** Skill trees are needed by setup, but not by check or trust-hash evaluation. */
  readonly includeSkills?: boolean | undefined;
}

/**
 * Reads the repository's trust-hashed content and any requested installable content in one snapshot.
 *
 * The result is what catalogs and planners consume for the whole run: applying from this snapshot
 * rather than from a re-read is what closes the window between the bytes the user consented to
 * and the bytes a later write could put on disk. A broken snippet set fails the run — those bytes
 * are inside the trust hash — while a broken skill tree only shrinks the offers, because skills
 * stay behind the per-skill review.
 */
export async function readRepoContent(
  auraDir: string,
  preset: AuraTeamPreset,
  presetText: string,
  reader: FileReader,
  options: RepoContentReadOptions = {},
): Promise<RepoContentResult> {
  const boundary = (await reader.realPath(auraDir)) ?? auraDir;
  const snippets = await readRepoSnippets(join(auraDir, "snippets"), boundary, reader);
  if (snippets.status === "invalid") {
    return {
      diagnostics: [
        {
          adapterId: REPO_CONTENT_DIAGNOSTIC_ID,
          message: `Repository snippets directory ".aura/snippets" ${snippets.problem}.`,
          path: join(auraDir, "snippets"),
          phase: "read",
        },
      ],
      status: "invalid",
    };
  }

  const snippetBytes = snippets.files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.text, "utf8"),
    0,
  );
  if (snippetBytes > MAX_REPO_CONTENT_TOTAL_BYTES) {
    return {
      diagnostics: [
        {
          adapterId: REPO_CONTENT_DIAGNOSTIC_ID,
          message: `Repository snippets exceed the ${String(MAX_REPO_CONTENT_TOTAL_BYTES)} byte repository content budget.`,
          path: join(auraDir, "snippets"),
          phase: "read",
        },
      ],
      status: "invalid",
    };
  }

  const skills =
    options.includeSkills === false
      ? { diagnostics: [], skills: [] }
      : await resolveRepoSkills(
          join(auraDir, "skills"),
          boundary,
          reader,
          MAX_REPO_CONTENT_TOTAL_BYTES - snippetBytes,
        );
  return {
    contentSet: Object.freeze({
      mcpServers: preset.provides?.mcpServers ?? [],
      skills: skills.skills,
      snippets: Object.freeze(snippets.files.map((file) => file.entry)),
    }),
    diagnostics: skills.diagnostics,
    hash: hashRepoContentSet(
      presetText,
      snippets.files.map((file) => ({ id: file.entry.id, text: file.text })),
    ),
    status: "ready",
  };
}

/**
 * Lifts the preset's inline MCP definitions into catalog entries.
 *
 * The `repo/` namespace is reserved against plugins at registry build, so these can never collide
 * with — or be shadowed by — a plugin catalog entry. The source URL names the preset file itself:
 * that is the file whose bytes the user trusted.
 */
export function repoMcpServerDefs(
  servers: readonly McpServerManifest[],
  presetPath: string,
): readonly ResolvedMcpServerDef[] {
  return Object.freeze(
    servers.map((manifest) =>
      Object.freeze({
        description: manifest.description,
        id: manifest.id,
        kind: "mcp-server" as const,
        manifest,
        name: manifest.name,
        source: Object.freeze({ type: "file" as const, url: pathToFileURL(presetPath).href }),
        version: "0.0.0",
      }),
    ),
  );
}

/**
 * Hashes the repository content set for the trust record.
 *
 * With no snippet files the hash is exactly the preset file's own content hash, so a repository
 * that never adds `.aura/snippets` keeps every trust its users already recorded. The first
 * snippet changes the descriptor shape — and consent is re-asked, which is the point.
 */
export function hashRepoContentSet(
  presetText: string,
  snippets: readonly { readonly id: string; readonly text: string }[],
): string {
  if (snippets.length === 0) {
    return hashContent(presetText);
  }
  const lines = [
    "aura-repo-content-v1",
    `preset ${hashContent(presetText)}`,
    ...[...snippets]
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map((file) => `snippet ${file.id} ${hashContent(file.text)}`),
  ];
  return hashContent(lines.join("\n"));
}
