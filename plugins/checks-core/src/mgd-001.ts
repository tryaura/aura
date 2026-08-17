import { defineCheck, type DetectedFinding, type WorkspaceModel } from "@tryaura/aura-sdk";

import { displayInstructionPath } from "./instruction-paths.js";
import { managedDocuments, type ManagedDocument } from "./mgd-001-documents.js";
import { guidedFixes } from "./mgd-001-fixes.js";

const CHECK_ID = "MGD-001";

export const managedBlockHashCheck = defineCheck({
  defaultSeverity: "warn",
  detect: detectManagedBlockDrift,
  explain: `Aura hashes each managed snippet so hand edits cannot be overwritten silently. A mismatch means the installed text no longer matches the registered version, so a later setup run must not guess which side should win.

Re-run the check with \`--fix --interactive\` and choose Keep yours to adopt the edit, Restore to return to registered content, or Merge to review both versions and reconcile them manually. Every executable choice is previewed and backed up before Aura writes.`,
  fix: () => undefined,
  fixability: "guided",
  guidedFixes: guidedFixes,
  id: CHECK_ID,
  scope: "global",
  title: "Aura-managed instruction blocks have not changed by hand",
});

function detectManagedBlockDrift(model: WorkspaceModel): readonly DetectedFinding[] {
  return managedDocuments(model).flatMap((document) => findingsForDocument(document, model));
}

function findingsForDocument(
  document: ManagedDocument,
  model: WorkspaceModel,
): readonly DetectedFinding[] {
  const parsed = document.parsed;
  const hiddenMarker = parsed.notes.find((note) => note.code === "unterminated-fence");
  if (hiddenMarker !== undefined) {
    return [unterminatedFenceFinding(document, hiddenMarker.line, model)];
  }
  if (parsed.status === "invalid") {
    return [malformedFinding(document, parsed.problems, model)];
  }
  if (parsed.status === "absent") {
    return [];
  }

  const manifestHashes = manifestSnippetHashes(model);
  return parsed.block.snippets
    .filter((snippet) => {
      const manifestHash = manifestHashes.get(snippet.id);
      return (
        !snippet.hashMatches ||
        (manifestHash !== undefined && manifestHash !== snippet.computedHash)
      );
    })
    .map((snippet) => ({
      details:
        "Run `aura check --fix --interactive` and choose Keep yours, Restore, or Merge before running setup again.",
      id: `${document.sourceId}:${snippet.id}`,
      locations: [{ line: snippet.startLine, path: document.path }],
      message: `Managed snippet ${snippet.id} in ${displayInstructionPath(document.path, model)} was edited by hand.`,
      metadata: {
        kind: "hash-mismatch",
        snippetId: snippet.id,
        sourceId: document.sourceId,
      },
    }));
}

function unterminatedFenceFinding(
  document: ManagedDocument,
  line: number | undefined,
  model: WorkspaceModel,
): DetectedFinding {
  return {
    details:
      "Close the Markdown fence, then run `aura check --fix --interactive` again. Aura will not reconcile this document while its markers are hidden.",
    id: `${document.sourceId}:unterminated-fence`,
    locations: [{ ...(line === undefined ? {} : { line }), path: document.path }],
    message: `An unclosed Markdown fence hides Aura-managed markers in ${displayInstructionPath(document.path, model)}.`,
    metadata: { kind: "unterminated-fence", sourceId: document.sourceId },
  };
}

function malformedFinding(
  document: ManagedDocument,
  problems: Extract<ManagedDocument["parsed"], { readonly status: "invalid" }>["problems"],
  model: WorkspaceModel,
): DetectedFinding {
  return {
    details: `${problems.map((problem) => problem.message).join(" ")} Aura will not write to a block it cannot parse; repair the markers by hand.`,
    id: `${document.sourceId}:malformed-managed-block`,
    locations: problems.map((problem) => ({
      ...(problem.line === undefined ? {} : { line: problem.line }),
      path: document.path,
    })),
    message: `The Aura-managed block in ${displayInstructionPath(document.path, model)} is malformed.`,
    metadata: {
      kind: "malformed",
      problems: problems.map((problem) => ({
        code: problem.code,
        ...(problem.line === undefined ? {} : { line: problem.line }),
      })),
      sourceId: document.sourceId,
    },
  };
}

function manifestSnippetHashes(model: WorkspaceModel): ReadonlyMap<string, string> {
  if (model.manifest.status !== "ready") {
    return new Map();
  }
  const hashes = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const snippet of model.manifest.value.snippets) {
    if (hashes.has(snippet.id)) {
      ambiguous.add(snippet.id);
    } else {
      hashes.set(snippet.id, snippet.hash);
    }
  }
  for (const id of ambiguous) {
    hashes.delete(id);
  }
  return hashes;
}
