import type { Scope } from "./common.js";

/** A stable, value-free description of where an inline MCP credential was found. */
export type McpSecretLocator =
  | { readonly kind: "arg"; readonly index: number }
  | { readonly kind: "env"; readonly name: string }
  | { readonly component: "password" | "username"; readonly kind: "url-userinfo" }
  | { readonly kind: "url-query"; readonly name: string }
  | { readonly index: number; readonly kind: "url-path" }
  | { readonly kind: "header"; readonly name: string };

/** Safe identity for one inline MCP credential. Secret bytes, prefixes, and lengths are omitted. */
export interface McpSecretSighting {
  readonly appId: string;
  /** Stable, user-readable field path within the server entry. */
  readonly field: string;
  readonly locator: McpSecretLocator;
  /** Object path to the record containing the named server. */
  readonly recordPath: readonly string[];
  readonly scope: Scope;
  readonly serverName: string;
  readonly sourceId: string;
  readonly suggestedEnvName: string;
}

/** Input to an adapter's private whole-file secret transformation. */
export interface McpSecretTransformInput {
  readonly content: string;
  readonly sightings: readonly McpSecretSighting[];
}

/**
 * Masked content plus what the masker could not account for.
 *
 * A redactor that returns only a string cannot distinguish "masked every field" from "found none of
 * them and changed nothing", and the second case renders a credential into a preview. Naming the
 * fields whose server entry could not be located in this content is what lets the caller decide,
 * rather than reading success into a string that came back.
 */
export interface McpSecretRedaction {
  readonly content: string;
  /** Fields whose server entry could not be located in the content that was masked. */
  readonly unresolved: readonly string[];
}

/** Adapter-owned transformations used behind core's raw-config boundary. */
export interface McpSecretTransform {
  /** Masks every sighting in arbitrary old or new content for semantic previews. */
  readonly redact: (input: McpSecretTransformInput) => McpSecretRedaction | undefined;
  /** Replaces every behavior-preserving sighting and reports the safe fields it handled. */
  readonly rewrite: (input: McpSecretTransformInput) => McpSecretRewriteResult;
  /** Whether this adapter can replace the sighting without changing behavior. */
  readonly supports: (sighting: McpSecretSighting) => boolean;
}

export type McpSecretRewriteResult =
  | { readonly content: string; readonly rewrittenFields: readonly string[] }
  | { readonly refusal: string };

/** Context common to every sighting collected from one server entry. */
export interface McpSecretInspectionContext {
  readonly appId: string;
  readonly recordPath: readonly string[];
  readonly scope: Scope;
  readonly serverName: string;
  readonly sourceId: string;
  /** Application-specific environment-reference syntax. Must carry the global flag. */
  readonly variablePattern: RegExp;
}

/** One collected field, before a suggested environment name has been chosen for it. */
export interface McpSecretSightingDraft {
  readonly context: McpSecretInspectionContext;
  readonly field: string;
  readonly locator: McpSecretLocator;
  readonly preferredEnvName?: string | undefined;
}
