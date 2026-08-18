import { Buffer } from "node:buffer";

import type {
  FileMode,
  McpSecretSighting,
  McpSecretTransform,
  WriteFileOperation,
} from "@tryaura/aura-sdk";

import { renderWriteDiff, renderWriteSummary } from "./diff.js";
import type { PathState } from "./state.js";

type ContentRedactor = (content: string) => string | undefined;

const REDACTORS = new WeakMap<WriteFileOperation, readonly ContentRedactor[]>();

/**
 * Paths some operation has asked to have redacted, kept beside the identity-keyed registry above.
 *
 * The registry is keyed on the operation object, so anything that copies an operation between
 * planning and preview silently drops its masker — and the symptom of that would be a credential
 * rendered into a diff rather than an error. Remembering the path as well turns the silent case
 * into the conservative one: a write to a path that has ever needed masking and arrives without a
 * masker gets a summary, not a patch.
 */
const REDACTED_PATHS = new Set<string>();

/** Associates a semantic content masker with a write without changing the public operation schema. */
export function rememberWriteRedactor(
  operation: WriteFileOperation,
  redactor: ContentRedactor,
): void {
  const existing = REDACTORS.get(operation) ?? [];
  REDACTORS.set(operation, [...existing, redactor]);
  REDACTED_PATHS.add(operation.path);
}

/**
 * Wraps an adapter's transform so a projection that could not account for every field fails closed.
 *
 * `unresolved` names the fields whose server entry this content does not contain. That is not the
 * same as "nothing to mask": a rewritten side legitimately has nothing left to mask and reports no
 * unresolved fields, while a document shaped in a way the adapter cannot navigate reports them all
 * and still holds the credential.
 */
export function mcpSecretRedactor(
  transform: McpSecretTransform,
  sightings: readonly McpSecretSighting[],
): ContentRedactor {
  return (content) => {
    const redaction = transform.redact({ content, sightings });
    return redaction === undefined || redaction.unresolved.length > 0
      ? undefined
      : redaction.content;
  };
}

/** Renders a write only after every registered semantic masker succeeds on both diff sides. */
export function renderRedactedWriteDiff(
  operations: readonly WriteFileOperation[],
  path: string,
  before: PathState,
  content: string,
  requestedMode: FileMode | undefined,
  mode: number,
): string {
  const redactors = operations.flatMap((operation) => REDACTORS.get(operation) ?? []);
  if (redactors.length === 0) {
    return REDACTED_PATHS.has(path)
      ? renderWriteSummary(path, before, requestedMode, mode)
      : renderWriteDiff(path, before, content, requestedMode, mode);
  }

  const next = redactAll(redactors, content);
  if (next === undefined) {
    return renderWriteSummary(path, before, requestedMode, mode);
  }
  // A file being created has no previous side to project, and nothing to leak from one.
  if (before.kind !== "file" || before.content === undefined) {
    return renderWriteDiff(path, before, next, requestedMode, mode);
  }
  const previous = redactAll(redactors, before.content.toString("utf8"));
  if (previous === undefined) {
    return renderWriteSummary(path, before, requestedMode, mode);
  }
  return renderWriteDiff(
    path,
    { ...before, content: Buffer.from(previous, "utf8") },
    next,
    requestedMode,
    mode,
  );
}

function redactAll(redactors: readonly ContentRedactor[], content: string): string | undefined {
  let projected = content;
  for (const redact of redactors) {
    const result = safeRedact(redact, projected);
    if (result === undefined) {
      return undefined;
    }
    projected = result;
  }
  return projected;
}

function safeRedact(redact: ContentRedactor, content: string): string | undefined {
  try {
    return redact(content);
  } catch {
    return undefined;
  }
}
