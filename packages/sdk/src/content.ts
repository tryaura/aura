import type { Environment } from "./environment.js";

/**
 * A single file bundled with a plugin.
 *
 * `url` must be an absolute `file:` URL. Build it with {@link pluginContentUrl} so the reference
 * stays correct wherever the package is installed, including inside a compiled executable:
 *
 * ```ts
 * const url = pluginContentUrl(import.meta.url, "rules.md");
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

/** Fields shared by a skill listing and its resolved directory. */
export interface SkillListing {
  /** One sentence describing what this skill does. */
  readonly description: string;
  /** Source-local, kebab-case identifier and installation directory name. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /**
   * Where this skill's bytes actually come from, when that is not the directory's own URL.
   *
   * A directory that indexes content hosted elsewhere — a metadata feed pointing at GitHub — must
   * name the real origin here. It is what the review step shows at the moment the user grants
   * trust, so approving a skill is approving the host that serves it rather than the catalog that
   * advertised it.
   */
  readonly originUrl?: string | undefined;
  /** Semver version of the skill. */
  readonly version: string;
}

/** A skill directory a user can install. */
export interface SkillPack extends SkillListing {
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

/**
 * A driver that discovers skills somewhere other than the plugin's own package.
 *
 * Both methods may use {@link Environment.exec}, so they run at build time rather than during a
 * check run.
 */
export interface SkillSourceDriver {
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

/** Stable provenance carried by resolved packs and manifest selections. */
export type SkillSourceId = `directory:${string}` | `driver:${string}` | `plugin:${string}`;

/** A plugin's bundled skill collection. */
export interface BundledSkillSource {
  readonly id: Extract<SkillSourceId, `plugin:${string}`>;
  readonly kind: "bundled";
  readonly name: string;
}

/** A public directory using Aura's native protocol or a named built-in provider adapter. */
export interface StandardDirectorySkillSource {
  readonly id: Extract<SkillSourceId, `directory:${string}`>;
  readonly kind: "directory";
  readonly name: string;
  /** Omit for Aura's native protocol; registered providers may select a built-in adapter. */
  readonly protocol?: "agenticskills" | undefined;
  readonly url: string;
}

/**
 * A standard directory authenticated with a token read from the named environment variable.
 * Clients must obtain explicit user approval before connecting or reading that variable.
 */
export interface PrivateDirectorySkillSource {
  readonly id: Extract<SkillSourceId, `directory:${string}`>;
  readonly kind: "private-directory";
  readonly name: string;
  readonly tokenEnv: string;
  readonly url: string;
}

/** A build-time driver for a non-standard skill directory protocol. */
export interface DriverSkillSource {
  readonly driver: SkillSourceDriver;
  readonly id: Extract<SkillSourceId, `driver:${string}`>;
  readonly kind: "driver";
  readonly name: string;
}

/** A remote skill directory Aura's built-in client can talk to. Pure config, never code. */
export type DirectorySkillSource = PrivateDirectorySkillSource | StandardDirectorySkillSource;

/** Stable source metadata paired with a source-local skill id. */
export type SkillSource =
  | BundledSkillSource
  | DriverSkillSource
  | PrivateDirectorySkillSource
  | StandardDirectorySkillSource;

/** One normalized UTF-8 file in a resolved skill pack. */
export interface ResolvedSkillFile {
  readonly content: string;
  /** Portable, slash-separated path relative to the skill root. */
  readonly path: string;
}

/** A catalog entry paired with the source that advertised its local id. */
export interface ResolvedSkillListing extends SkillListing {
  readonly source: SkillSource;
}

/** A source-attached skill directory ready for preview or fix-plan writes. */
export interface ResolvedSkillPack extends ResolvedSkillListing {
  readonly files: readonly ResolvedSkillFile[];
  readonly treeHash: string;
}
