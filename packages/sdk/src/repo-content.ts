import type { ResolvedSkillPack } from "./content.js";
import type { McpServerManifest } from "./mcp-definition-types.js";

/**
 * Content a repository preset defines itself, beyond selecting what plugins publish.
 *
 * Data only, never code. MCP definitions live inline so the executable-adjacent surface —
 * command, arguments, environment variable names — is covered by the preset file's own trust
 * hash and can be shown verbatim at the trust prompt. Only the repository layer may carry this
 * field; a fetched preset that presents it fails validation.
 */
export interface AuraTeamPresetProvides {
  /** Full MCP server definitions. Every id must be namespaced `repo/<name>`. */
  readonly mcpServers?: readonly McpServerManifest[] | undefined;
}

/**
 * One Markdown fragment discovered under `.aura/snippets`.
 *
 * The body's bytes are folded into the repository trust hash, and a first install still requires
 * an explicit interactive tick. The snapshot ensures that tick appends the reviewed bytes rather
 * than whatever happens to be on disk later in the run.
 */
export interface RepoSnippetEntry {
  /** Markdown after the optional frontmatter block. */
  readonly body: string;
  /** Frontmatter `description`, when present. */
  readonly description?: string | undefined;
  /** Catalog id: `repo/` followed by the file's stem. */
  readonly id: string;
  /** Frontmatter `name`, defaulting to the file's stem. */
  readonly name: string;
}

/**
 * The repository-defined content read for one run.
 *
 * Read once alongside the trust decision and held in memory: catalogs and planners consume this
 * snapshot, never a re-read, so a write landing after resolution cannot change what the run
 * applies. Skill trees are the one part outside the trust hash — they are offers gated by the
 * per-skill review, not bytes an unattended run could apply.
 */
export interface RepoContentSet {
  /** Parsed MCP definitions from the preset's `provides.mcpServers`. */
  readonly mcpServers: readonly McpServerManifest[];
  /** Skill trees discovered under `.aura/skills`, resolved with their tree hashes. */
  readonly skills: readonly ResolvedSkillPack[];
  /** Snippets discovered under `.aura/snippets`, sorted by id. */
  readonly snippets: readonly RepoSnippetEntry[];
}
