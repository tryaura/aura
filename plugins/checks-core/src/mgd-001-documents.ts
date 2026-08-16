import { resolve } from "node:path";

import type { InstructionDocument, WorkspaceModel } from "@tryaura/aura-sdk";
import { type ManagedBlockReadResult, readManagedBlock } from "@tryaura/core";

import { canonicalInstructionDocuments } from "./instruction-documents.js";

const SHARED_SOURCE_ID = "aura.shared-instructions";

export interface ManagedDocument {
  readonly content: string;
  /** The block as the protocol reader sees it, parsed once per model. */
  readonly parsed: ManagedBlockReadResult;
  readonly path: string;
  readonly sourceId: string;
}

/**
 * Every document whose managed block this check owns, parsed.
 *
 * Memoized per model because detection and remediation ask the same question: `detect` walks the
 * set once, then each finding's guided fixes look its document back up. Rebuilding the set per
 * finding re-resolves every instruction path and re-parses every block to reach an answer that
 * cannot have changed — the model is frozen for the length of a run.
 */
const CACHE = new WeakMap<WorkspaceModel, readonly ManagedDocument[]>();

export function managedDocuments(model: WorkspaceModel): readonly ManagedDocument[] {
  const cached = CACHE.get(model);
  if (cached !== undefined) {
    return cached;
  }

  const documents = new Map<string, ManagedDocument>();
  if (model.sharedInstructions.content !== undefined) {
    documents.set(
      resolve(model.sharedInstructions.path),
      managedDocument(
        model.sharedInstructions.content,
        model.sharedInstructions.path,
        SHARED_SOURCE_ID,
      ),
    );
  }

  for (const document of canonicalInstructionDocuments(model.instructionFiles)) {
    const path = resolve(document.path);
    if (!documents.has(path) && !isSymlinkDocument(document, model)) {
      documents.set(path, managedDocument(document.content, document.path, document.sourceId));
    }
  }

  const resolved = Object.freeze([...documents.values()]);
  CACHE.set(model, resolved);
  return resolved;
}

/** Finds the document one finding was raised against, without rebuilding the set. */
export function findManagedDocument(
  model: WorkspaceModel,
  sourceId: string,
  path: string,
): ManagedDocument | undefined {
  const target = resolve(path);
  return managedDocuments(model).find(
    (document) => document.sourceId === sourceId && resolve(document.path) === target,
  );
}

function managedDocument(content: string, path: string, sourceId: string): ManagedDocument {
  return Object.freeze({ content, parsed: readManagedBlock(content), path, sourceId });
}

function isSymlinkDocument(document: InstructionDocument, model: WorkspaceModel): boolean {
  const path = resolve(document.path);
  return model.apps.some((app) =>
    app.sourceFiles.some(
      (file) =>
        file.spec.id === document.sourceId &&
        resolve(file.spec.path) === path &&
        file.pathKind === "symlink",
    ),
  );
}
