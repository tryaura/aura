import type { McpServerDef } from "./content.js";

/** One credential environment variable a catalog entry requires. */
export interface McpCredentialEnvironmentVariable {
  /** Why the server needs this variable. */
  readonly description: string;
  /** Environment-variable name. Values never belong in a catalog or Aura manifest. */
  readonly name: string;
  /** Optional HTTP(S) page where the user can create or configure the credential. */
  readonly setupUrl?: string | undefined;
}

/** A child-process MCP transport safe to persist as desired state. */
export interface StdioMcpServerDefinition {
  /** Arguments passed to the command. Recognizable credential literals are rejected. */
  readonly args?: readonly string[] | undefined;
  /** Executable name or absolute path. */
  readonly command: string;
  /** Credential environment-variable names, never values. */
  readonly env?: readonly string[] | undefined;
  readonly type: "stdio";
}

/** An HTTP MCP transport safe to persist as desired state. */
export interface HttpMcpServerDefinition {
  /** Header templates containing `${VARIABLE}` references rather than credential values. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly type: "http";
  /** Absolute HTTP(S) endpoint without embedded credentials. */
  readonly url: string;
}

/** A normalized MCP transport used by manifests and catalog templates. */
export type McpServerDefinition = HttpMcpServerDefinition | StdioMcpServerDefinition;

/** Version 1 of the JSON payload referenced by a plugin {@link McpServerDef}. */
export interface McpServerManifest {
  /** Credential variables referenced by {@link transportTemplate}. */
  readonly credentialEnv: readonly McpCredentialEnvironmentVariable[];
  /** One sentence describing what the server provides. */
  readonly description: string;
  /** HTTP(S) documentation for configuring or using the server. */
  readonly docsUrl: string;
  /** Stable, plugin-namespaced catalog identifier. */
  readonly id: string;
  /** Human-readable catalog name. */
  readonly name: string;
  readonly schemaVersion: 1;
  /** Adapter ids this template can target. Omitted means no catalog-level restriction. */
  readonly supportedApps?: readonly string[] | undefined;
  /** Transport instantiated into the desired-state manifest when selected. */
  readonly transportTemplate: McpServerDefinition;
}

/** A catalog contribution paired with the validated payload its source file holds. */
export interface ResolvedMcpServerDef extends McpServerDef {
  readonly manifest: McpServerManifest;
}

/** A field-addressed MCP definition validation failure. */
export interface McpDefinitionError {
  readonly message: string;
  readonly path: string;
}

/** Result of parsing an MCP server manifest or transport. */
export type McpDefinitionResult<T> = { readonly error: McpDefinitionError } | { readonly value: T };
