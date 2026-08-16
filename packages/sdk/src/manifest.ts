import type { FileProblem } from "./adapter.js";

/**
 * One entry in a manifest section this release does not define.
 *
 * Deliberately opaque rather than {@link JsonObject}. The manifest is a private `0o600` file, and
 * the sections reserved below will carry MCP server definitions whose `env` blocks hold API tokens.
 * `JsonObject` is documented as the shape that gets serialized into reports, logs, and CI output,
 * so manifest contents must not be assignable to it: a check cannot forward one of these into
 * `Finding.metadata` without narrowing it deliberately first.
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

/** One managed snippet and the source revision selected for it. */
export interface AuraManifestSnippet {
  /** Stable, namespaced snippet identifier. */
  readonly id: string;
  /** Hash of the canonical snippet contents. */
  readonly hash: string;
  /** Whether automatic update guidance is suppressed for this selection. */
  readonly pinned: boolean;
  /** Source version selected when the snippet was installed. */
  readonly version: string;
}

/** The exact entries Aura last wrote for one application. */
export interface AuraManifestOwnership {
  /** Managed file or managed-block references owned by Aura. */
  readonly files: readonly string[];
  /** MCP server names written by Aura on the previous converge. */
  readonly mcpServerNames: readonly string[];
}

/** Version 1 of the distribution-independent `~/agents/aura.json` protocol. */
export interface AuraManifestV1 {
  /** Application selections keyed by stable adapter id. */
  readonly apps: Readonly<Record<string, AuraManifestApp>>;
  /** Reserved for manifest MCP definitions introduced by the MCP milestone. */
  readonly mcpServers: readonly AuraManifestEntry[];
  /** What Aura owns in each application's configuration, keyed by adapter id. */
  readonly ownership: Readonly<Record<string, AuraManifestOwnership>>;
  readonly schemaVersion: 1;
  /** Reserved for manifest skill selections introduced by the skills milestone. */
  readonly skills: readonly AuraManifestEntry[];
  /** Managed snippet selections. */
  readonly snippets: readonly AuraManifestSnippet[];
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
