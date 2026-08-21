import type { FileProblem } from "./adapter.js";
import type { SkillSourceId } from "./content.js";
import type { AuraCheckConfiguration } from "./configuration.js";
import type { McpServerDefinition } from "./mcp-definition-types.js";

/**
 * One entry in a manifest section this release does not define.
 *
 * Deliberately opaque rather than {@link JsonObject}. The manifest is a private `0o600` file and
 * future sections may carry private source references. `JsonObject` is documented as the shape
 * that gets serialized into reports, logs, and CI output, so manifest contents must not be
 * assignable to it: a check cannot forward one of these into `Finding.metadata` without narrowing
 * it deliberately first.
 *
 * Entries round-trip verbatim regardless of what this release understands about them.
 */
export type AuraManifestEntry = unknown;

/**
 * One agent application selected in Aura's desired-state manifest.
 *
 * Extension fields are preserved on write but left untyped, for the reason on
 * {@link AuraManifestEntry}.
 */
export interface AuraManifestApp {
  /** Whether Aura should currently converge this application's configuration. */
  readonly managed: boolean;
}

/**
 * One snippet installed into the shared instructions, and a fingerprint of what was appended.
 *
 * The record is install history, not desired text: Aura never rewrites an installed snippet from
 * it. The hash exists so a later run can still say which text it planted — plugin-authored
 * Markdown carries no markers once it is in the file, and without a fingerprint there is nothing
 * left that distinguishes it from the user's own guidance.
 */
export interface AuraManifestSnippet {
  /**
   * Canonical hash of the Markdown Aura appended.
   *
   * Optional because a record written before Aura kept one carries no fingerprint, and dropping
   * such a record to satisfy the shape would re-offer a snippet the user already has.
   */
  readonly hash?: string | undefined;
  /** Stable, namespaced snippet identifier. */
  readonly id: string;
}

/** One managed skill and the exact source tree selected for it. */
export interface AuraManifestSkill {
  /** Source-local skill identifier and shared installation directory name. */
  readonly id: string;
  /** Whether automatic source updates are suppressed for this selection. */
  readonly pinned: boolean;
  /** Stable source provenance such as `plugin:official` or `directory:agenticskills`. */
  readonly source: SkillSourceId;
  /** Deterministic signature of every file in the installed skill tree. */
  readonly treeHash: string;
  /** Source version selected when the skill was installed. */
  readonly version: string;
}

/** One MCP server Aura should converge into the selected applications. */
export interface AuraManifestMcpServer {
  /** Adapter ids that should receive this server. */
  readonly apps: readonly string[];
  /** Catalog provenance. Omitted for a custom server. */
  readonly catalogId?: string | undefined;
  /** Server key written into each target application's configuration. */
  readonly name: string;
  /** How each target application reaches the server. */
  readonly transport: McpServerDefinition;
}

/** The exact entries Aura last wrote for one application. */
export interface AuraManifestOwnership {
  /** Managed file or managed-block references owned by Aura. */
  readonly files: readonly string[];
  /** MCP server names written by Aura on the previous converge. */
  readonly mcpServerNames: readonly string[];
}

/** Explicit departures from policy selected by the user during setup. */
export interface AuraManifestOverrides {
  /** Preset-required MCP catalog entries the user chose not to configure. */
  readonly requiredMcpServers?: readonly string[] | undefined;
}

/**
 * One repository preset the user accepted during interactive setup.
 *
 * Trust binds to exact contents and to the repository, not to the directory the run started in: a
 * `.aura/preset.json` that changes after acceptance is treated as untrusted again until the user
 * reviews the new contents, while a linked worktree holding those same contents applies them
 * without asking. Only acceptances are recorded — declining leaves no entry, so the next
 * interactive setup asks again.
 */
export interface AuraManifestTrustedRepoPreset {
  /** Hash of the canonicalized preset contents that were accepted. */
  readonly hash: string;
  /**
   * Same preset path resolved against the repository's primary Git checkout.
   *
   * Present only when the acceptance happened inside a linked worktree. It is an identity token
   * for the repository — compared against other entries, never opened — so trusting one worktree
   * covers its siblings without granting the primary checkout's own file any standing.
   */
  readonly mainWorktreePath?: string | undefined;
  /** Absolute path of the repository preset file. */
  readonly path: string;
}

/** Version 1 of the distribution-independent `~/agents/aura.json` protocol. */
export interface AuraManifestV1 {
  /** Application selections keyed by stable adapter id. */
  readonly apps: Readonly<Record<string, AuraManifestApp>>;
  /** Per-user check overrides applied above the selected team preset. */
  readonly checks?: AuraCheckConfiguration | undefined;
  /** Detected applications the user deliberately leaves outside Aura management. */
  readonly ignoredApps?: readonly string[] | undefined;
  /** MCP servers Aura should converge into their selected applications. */
  readonly mcpServers: readonly AuraManifestMcpServer[];
  /** What Aura owns in each application's configuration, keyed by adapter id. */
  readonly ownership: Readonly<Record<string, AuraManifestOwnership>>;
  /** Explicit, reviewable departures from the active team preset. */
  readonly overrides?: AuraManifestOverrides | undefined;
  /** Sticky runtime preset reference. CLI `--preset` overrides it for one run. */
  readonly preset?: string | undefined;
  readonly schemaVersion: 1;
  /** Managed skill selections and their source provenance. */
  readonly skills: readonly AuraManifestSkill[];
  /** Snippets installed into the shared instructions, in installation order. */
  readonly snippets: readonly AuraManifestSnippet[];
  /** Repository presets accepted for this user, keyed by absolute preset path. */
  readonly trustedRepoPresets?: readonly AuraManifestTrustedRepoPreset[] | undefined;
}

/** The manifest shape understood by this SDK release. */
export type AuraManifest = AuraManifestV1;

/** Why an existing manifest cannot be used as writable desired state. */
export type AuraManifestProblem =
  | {
      readonly kind: "file";
      readonly message: string;
      readonly reason: FileProblem;
    }
  | {
      readonly jsonPath: string;
      readonly kind: "invalid-schema";
      readonly message: string;
    }
  | {
      readonly column?: number | undefined;
      readonly kind: "invalid-json";
      readonly line?: number | undefined;
      readonly message: string;
    }
  | {
      readonly actualVersion: number;
      readonly kind: "unsupported-version";
      readonly message: string;
      readonly supportedVersion: 1;
    };

/** Core's normalized read of `~/agents/aura.json`. */
export type AuraManifestState =
  | {
      readonly exists: false;
      readonly path: string;
      readonly status: "missing";
    }
  | {
      readonly exists: true;
      /**
       * Permission bits the file currently carries, absent when they could not be observed.
       *
       * Core pins this file to {@link AURA_MANIFEST_FILE_MODE} on every write, so a planner that
       * skips a write because the parsed value already matches has to check this too — otherwise a
       * manifest someone chmodded stays that way forever.
       */
      readonly mode?: number | undefined;
      readonly path: string;
      readonly status: "ready";
      readonly value: AuraManifest;
    }
  | {
      /** False when inspecting the path itself failed before existence could be established. */
      readonly exists: boolean;
      readonly path: string;
      readonly problem: AuraManifestProblem;
      readonly status: "read-only";
    };
