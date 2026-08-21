import type { Scope } from "./common.js";
import type { McpServerDefinition, StdioMcpServerDefinition } from "./mcp-definition-types.js";
import { variableReferences } from "./mcp-definition-values.js";
import { redactMcpArguments, sanitizeMcpUrl } from "./mcp.js";
import type { McpTransport } from "./model.js";

/** One manifest server selected for an adapter-owned configuration target. */
export interface OwnedServerEntry {
  readonly name: string;
  readonly transport: McpServerDefinition;
}

/** What core hands an adapter serializer for one declared MCP configuration file. */
export interface McpWriteInput {
  /** Servers this file's scope should end up declaring. */
  readonly desired: readonly OwnedServerEntry[];
  /** Current file contents, absent when the file does not exist. */
  readonly existingContent?: string | undefined;
  /** Names Aura wrote on the previous converge, and may therefore remove or replace. */
  readonly ledgerNames: readonly string[];
}

/**
 * A serializer outcome.
 *
 * Refusal is a return value rather than a thrown error so that the compiler asks every serializer
 * what it does about configuration it cannot represent. Core still catches a throw and treats it
 * as a refusal, because a serializer is plugin code and the kernel cannot assume it behaves.
 */
export type McpWriteResult = { readonly content: string } | { readonly refusal: string };

/** A pure adapter serializer for one declared MCP configuration file. */
export type McpWrite = (input: McpWriteInput) => McpWriteResult;

/**
 * A safe refusal raised from inside a serializer. Messages must never quote configuration contents.
 *
 * The SDK's own JSON and TOML helpers throw this across their internal call stacks and convert it
 * to an {@link McpWriteResult} at the boundary; an adapter may do the same.
 */
export class McpWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpWriteError";
  }
}

/** Runs a serializer body, turning its safe refusals into the result union. */
export function mcpWriteResult(build: () => string): McpWriteResult {
  try {
    return { content: build() };
  } catch (error) {
    if (error instanceof McpWriteError) {
      return { refusal: error.message };
    }
    throw error;
  }
}

/**
 * Why core cannot build an automatic MCP convergence plan.
 *
 * The whole of what a check learns about a refused convergence. Deliberately no operations and no
 * rendered contents: a blocker crosses into plugin code, and the files it describes are the ones
 * holding API tokens.
 */
export interface McpConvergenceBlocker {
  readonly message: string;
  readonly path?: string | undefined;
  readonly scope?: Scope | undefined;
  readonly sourceId?: string | undefined;
}

/** Builds the command-and-arguments portion shared by official stdio serializers. */
export function mcpCommandEntry(
  definition: StdioMcpServerDefinition,
): Readonly<Record<string, unknown>> {
  return {
    command: definition.command,
    ...(definition.args === undefined ? {} : { args: definition.args }),
  };
}

/**
 * Normalizes desired manifest transport data onto the credential-safe model shape.
 *
 * Desired state names credentials and never holds them, so the result never carries
 * `inlineCredentialValues`. That asymmetry is the point: it is what lets a check see that a
 * configured server stores a token where the manifest asks for a reference.
 */
export function normalizeMcpServerDefinition(definition: McpServerDefinition): McpTransport {
  if (definition.type === "stdio") {
    const original = definition.args ?? [];
    const args = redactMcpArguments(original);
    if (args.some((argument, index) => argument !== original[index])) {
      throw new McpWriteError(
        "The desired MCP server arguments contain a credential literal; use an ${ENV_VAR} reference.",
      );
    }
    const environmentVariables = [...new Set(definition.env ?? [])].sort();
    return {
      command: definition.command,
      type: "stdio",
      ...(args.length === 0 ? {} : { args }),
      ...(environmentVariables.length === 0 ? {} : { environmentVariables }),
    };
  }

  const url = sanitizeMcpUrl(definition.url);
  if (url === undefined) {
    throw new McpWriteError("The desired MCP server URL is not a valid absolute URL.");
  }
  const headerEnvironmentVariables = [
    ...new Set(Object.values(definition.headers ?? {}).flatMap(variableReferences)),
  ].sort();
  return {
    type: "http",
    url,
    ...(headerEnvironmentVariables.length === 0 ? {} : { headerEnvironmentVariables }),
  };
}
