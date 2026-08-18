import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  type Adapter,
  type AdapterFileMap,
  type AdapterSourceFile,
  type McpConvergenceBlocker,
  type McpServer,
  type McpSecretSighting,
  type McpWrite,
  type OwnedServerEntry,
  type Scope,
  type UnusableMcpServer,
  type WriteFileOperation,
} from "@tryaura/aura-sdk";

import { MAX_MUTABLE_FILE_BYTES } from "../fix-plan/limits.js";
import { mcpSecretRedactor, rememberWriteRedactor } from "../fix-plan/write-redaction.js";
import { classifyDesired } from "./mcp-classify.js";

/** What the planner made of one application's declared MCP targets. */
export interface AppMcpConvergenceResult {
  readonly blockers: readonly McpConvergenceBlocker[];
  readonly operations: readonly WriteFileOperation[];
  readonly ownedNames: readonly string[];
}

/**
 * Core's planner for one detected application.
 *
 * Holds the configuration bytes the scan read, which is why it is not part of {@link AppModel}: a
 * check receives the model, and `operations` carries whole rendered configuration files. Core keys
 * this off the app object from outside it, so the only thing plugin code can reach is
 * {@link McpConvergenceBlocker}.
 */
export type AppMcpConvergence = (
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
) => AppMcpConvergenceResult;

/** What one application's parsed MCP state contributes to planning a write. */
export interface AppMcpState {
  readonly secretSightings: readonly McpSecretSighting[];
  readonly servers: readonly McpServer[];
  readonly unusable: readonly UnusableMcpServer[];
}

/** Captures adapter source bytes behind a function, keeping them out of the model entirely. */
export function createAppMcpConvergence(
  adapter: Adapter,
  files: AdapterFileMap,
  state: AppMcpState,
): AppMcpConvergence | undefined {
  const writer = adapter.mcpWrite;
  if (writer === undefined) {
    return undefined;
  }
  const targets = [...files.values()].filter((file) => file.spec.kind === "mcp");

  return (desired, ledgerNames) => {
    const classified = classifyDesired(desired, ledgerNames, state);
    if (classified.blockers.length > 0) {
      return blocked(classified.blockers);
    }

    const scopes = (["global", "project"] satisfies readonly Scope[]).map((scope) =>
      planScope(
        adapter,
        writer,
        targets,
        classified.owned,
        ledgerNames,
        scope,
        state.secretSightings,
      ),
    );
    const blockers = scopes.flatMap((result) => result.blockers);
    const operations = scopes.flatMap((result) => result.operations);

    return blockers.length > 0
      ? blocked(blockers)
      : {
          blockers: [],
          operations,
          ownedNames: [...new Set(classified.owned.map((entry) => entry.name))].sort(),
        };
  };
}

interface ScopePlan {
  readonly blockers: readonly McpConvergenceBlocker[];
  readonly operations: AppMcpConvergenceResult["operations"];
}

function planScope(
  adapter: Adapter,
  writer: McpWrite,
  targets: readonly AdapterSourceFile[],
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
  scope: Scope,
  sightings: readonly McpSecretSighting[],
): ScopePlan {
  const scopedDesired = desired.filter((entry) => entry.scope === scope);
  const scopedTargets = targets.filter((target) => target.spec.scope === scope);
  if (scopedDesired.length > 0 && scopedTargets.length === 0) {
    return blockedScope(
      `${adapter.displayName} has no ${scope}-scope MCP configuration target.`,
      scope,
    );
  }
  if (scopedTargets.length > 1) {
    return blockedScope(
      `${adapter.displayName} declares more than one ${scope}-scope MCP write target.`,
      scope,
    );
  }
  const target = scopedTargets[0];
  return target === undefined
    ? { blockers: [], operations: [] }
    : writeScopeTarget(adapter, writer, target, scopedDesired, ledgerNames, scope, sightings);
}

function writeScopeTarget(
  adapter: Adapter,
  writer: McpWrite,
  target: AdapterSourceFile,
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
  scope: Scope,
  sightings: readonly McpSecretSighting[],
): ScopePlan {
  if (!needsTargetWrite(target, desired, ledgerNames)) {
    return { blockers: [], operations: [] };
  }
  const unwritable = targetRefusal(target);
  if (unwritable !== undefined) {
    return { blockers: [{ ...unwritable, scope, sourceId: target.spec.id }], operations: [] };
  }

  const written = runWriter(writer, target, desired, ledgerNames);
  if ("refusal" in written) {
    return {
      blockers: [
        { message: written.refusal, path: target.spec.path, scope, sourceId: target.spec.id },
      ],
      operations: [],
    };
  }
  if (Buffer.byteLength(written.content, "utf8") > MAX_MUTABLE_FILE_BYTES) {
    return {
      blockers: [
        {
          message: `${adapter.displayName}'s MCP configuration at ${target.spec.path} is larger than Aura will rewrite in one operation, so Aura left it unchanged.`,
          path: target.spec.path,
          scope,
          sourceId: target.spec.id,
        },
      ],
      operations: [],
    };
  }

  const operation: WriteFileOperation = {
    content: written.content,
    mode: scope === "global" ? 0o600 : 0o644,
    path: target.spec.path,
    precondition: targetPrecondition(target),
    type: "write",
  };
  rememberMcpRedactor(adapter, operation, target, sightings);
  return {
    blockers: [],
    operations: [operation],
  };
}

/**
 * Registers preview masking only for a target that actually holds an inline credential.
 *
 * Registering unconditionally would cost every convergence preview its diff, because masking has
 * no previous side to project when the fix is creating the file — which is what most MCP-001 fixes
 * do, on a file that by definition has no credentials in it yet.
 */
function rememberMcpRedactor(
  adapter: Adapter,
  operation: WriteFileOperation,
  target: AdapterSourceFile,
  sightings: readonly McpSecretSighting[],
): void {
  const transform = adapter.mcpSecrets;
  const scoped = sightings.filter((sighting) => sighting.sourceId === target.spec.id);
  if (transform === undefined || scoped.length === 0) {
    return;
  }
  rememberWriteRedactor(operation, mcpSecretRedactor(transform, scoped));
}

/** Runs a plugin serializer, treating a thrown error as the refusal it forgot to return. */
function runWriter(
  writer: McpWrite,
  target: AdapterSourceFile,
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
): { readonly content: string } | { readonly refusal: string } {
  try {
    return writer({
      desired,
      ...(target.content === undefined ? {} : { existingContent: target.content }),
      ledgerNames,
    });
  } catch {
    // The message is deliberately not the error's: a serializer that threw made no promise about
    // what its text quotes, and these files hold API tokens.
    return { refusal: "The MCP configuration serializer failed, so Aura left the file unchanged." };
  }
}

/**
 * What the file must still look like when the plan is applied.
 *
 * The rendered content is this file's own previous bytes with one section replaced, so applying it
 * against a file the application has since rewritten would silently revert that work. Declaring
 * what was read turns the race into a reported conflict.
 */
export function targetPrecondition(target: AdapterSourceFile): WriteFileOperation["precondition"] {
  return target.content === undefined
    ? { kind: "absent" }
    : { digest: createHash("sha256").update(target.content, "utf8").digest("hex"), kind: "sha256" };
}

function needsTargetWrite(
  target: AdapterSourceFile,
  desired: readonly OwnedServerEntry[],
  ledgerNames: readonly string[],
): boolean {
  const touched = desired.length > 0 || ledgerNames.length > 0;
  return touched && (target.exists || desired.length > 0);
}

/** Why this target cannot be rewritten safely, before a serializer is asked to try. */
export function targetRefusal(
  target: AdapterSourceFile,
): Pick<McpConvergenceBlocker, "message" | "path"> | undefined {
  const path = target.spec.path;
  if (target.problem !== undefined || (target.exists && target.content === undefined)) {
    return {
      message: `MCP configuration at ${path} could not be read safely, so Aura left it unchanged.`,
      path,
    };
  }
  return (target.size ?? 0) > MAX_MUTABLE_FILE_BYTES
    ? {
        message: `MCP configuration at ${path} is larger than Aura will rewrite in one operation, so Aura left it unchanged.`,
        path,
      }
    : undefined;
}

function blockedScope(message: string, scope: Scope): ScopePlan {
  return { blockers: [{ message, scope }], operations: [] };
}

function blocked(blockers: readonly McpConvergenceBlocker[]): AppMcpConvergenceResult {
  return { blockers, operations: [], ownedNames: [] };
}
