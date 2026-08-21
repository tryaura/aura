/** Bounds for repository-defined content under `.aura/`. */

/**
 * The most Markdown snippets one repository may define under `.aura/snippets`.
 *
 * Every body is folded into the trust hash and held in memory for the run, and the trust prompt
 * lists each one; a set too large to review is a set too large to consent to.
 */
export const MAX_REPO_SNIPPETS = 64;

/**
 * The most skill trees one repository may define under `.aura/skills`.
 *
 * Each is resolved with a full bounded tree walk at catalog build; the cap keeps a hostile
 * checkout from turning discovery into unbounded filesystem work.
 */
export const MAX_REPO_SKILLS = 32;

/**
 * The most MCP server definitions one repository preset may provide inline.
 *
 * Each is a command line or endpoint the trust prompt must spell out verbatim; the cap keeps
 * that prompt readable rather than scrollable past.
 */
export const MAX_REPO_MCP_SERVERS = 16;

/**
 * The largest combined byte size of a repository's content set.
 *
 * The snapshot lives in memory for the whole run so planners apply consented bytes rather than a
 * re-read; a repository must not be able to balloon that residency.
 */
export const MAX_REPO_CONTENT_TOTAL_BYTES = 16_000_000;
