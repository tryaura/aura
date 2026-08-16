import type { Environment } from "./environment.js";

/**
 * A single file bundled with a plugin.
 *
 * `url` must be an absolute `file:` URL. Build it relative to the plugin module so the reference
 * stays correct wherever the package is installed:
 *
 * ```ts
 * const url = new URL("./content/rules.md", import.meta.url).href;
 * ```
 */
export interface FileContentSource {
  /** Discriminant. */
  readonly type: "file";
  /** Absolute `file:` URL. Never a cwd-relative path. */
  readonly url: string;
}

/** A directory bundled with a plugin. See {@link FileContentSource} for how to build `url`. */
export interface DirectoryContentSource {
  /** Discriminant. */
  readonly type: "directory";
  /** Absolute `file:` URL. Never a cwd-relative path. */
  readonly url: string;
}

/** Fields shared by everything a plugin contributes as installable content. */
export interface ContentContribution {
  /** One sentence describing what this adds, shown when a user browses available content. */
  readonly description: string;
  /**
   * Stable identifier, namespaced by the owning {@link AuraPlugin.id}, such as `"acme/rules"`.
   *
   * The registry rejects a plugin whose contribution ids are not under its own namespace.
   */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Semver version of the content itself, independent of the plugin version. */
  readonly version: string;
}

/** A Markdown fragment a user can add to their instruction files. */
export interface Snippet extends ContentContribution {
  /** Picker group. Omitted contributions are shown under `general`. */
  readonly category?: string | undefined;
  /** Discriminant. */
  readonly kind: "snippet";
  /** The Markdown file. */
  readonly source: FileContentSource;
}

/** A skill directory a user can install. */
export interface SkillPack extends ContentContribution {
  /** Discriminant. */
  readonly kind: "skill-pack";
  /** The skill directory. */
  readonly source: DirectoryContentSource;
}

/** An MCP server definition a user can install. */
export interface McpServerDef extends ContentContribution {
  /** Discriminant. */
  readonly kind: "mcp-server";
  /** The JSON definition file. */
  readonly source: FileContentSource;
}

/** A named bundle of other contributions a user can install in one step. */
export interface Preset extends ContentContribution {
  /** Discriminant. */
  readonly kind: "preset";
  /** The JSON preset file. */
  readonly source: FileContentSource;
}

/** A skill advertised by a {@link SkillSource}, before its contents are resolved. */
export type SkillListing = ContentContribution;

/**
 * A driver that discovers skills somewhere other than the plugin's own package.
 *
 * Both methods may use {@link Environment.exec}, so they run at build time rather than during a
 * check run.
 */
export interface SkillSource {
  /** One sentence describing where the skills come from. */
  readonly description: string;
  /** Stable identifier, namespaced by the owning {@link AuraPlugin.id}. */
  readonly id: string;
  /** Advertises everything available, without fetching contents. */
  readonly list: (environment: Environment) => Promise<readonly SkillListing[]>;
  /** Human-readable name. */
  readonly name: string;
  /**
   * Fetches every requested skill in one call.
   *
   * Batched so that resolving a listing costs one round trip rather than one per skill. Ids that
   * cannot be resolved are omitted from the result rather than throwing.
   */
  readonly resolve: (
    environment: Environment,
    skillIds: readonly string[],
  ) => Promise<ReadonlyMap<string, SkillPack>>;
}
