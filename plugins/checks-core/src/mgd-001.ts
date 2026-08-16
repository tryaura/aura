import { defineCheck, type DetectedFinding, type WorkspaceModel } from "@tryaura/aura-sdk";

import { managedDocuments, type ManagedDocument } from "./mgd-001-documents.js";
import { guidedFixes } from "./mgd-001-fixes.js";

const CHECK_ID = "MGD-001";

export const managedBlockHashCheck = defineCheck({
  defaultSeverity: "warn",
  detect: detectManagedBlockDrift,
  // Capability and availability are two facts, as in every other fixability description: the three
  // resolutions are what this check can build, and nothing in this build asks the user to pick one.
  explain:
    "Aura hashes each managed snippet so hand edits cannot be overwritten silently. Keep adopts the edit, Restore returns to the registered content, and Merge leaves the file for a manual reconciliation. Picking between them needs an interactive client; no command in this build presents the choice, so Aura reports the drift and leaves the file alone.",
  fix: () => undefined,
  fixability: "guided",
  guidedFixes: guidedFixes,
  id: CHECK_ID,
  scope: "global",
  title: "Aura-managed instruction blocks have not changed by hand",
});

function detectManagedBlockDrift(model: WorkspaceModel): readonly DetectedFinding[] {
  return managedDocuments(model).flatMap((document) => findingsForDocument(document));
}

function findingsForDocument(document: ManagedDocument): readonly DetectedFinding[] {
  const parsed = document.parsed;
  if (parsed.status === "invalid") {
    return [
      {
        details: `${parsed.problems.map((problem) => problem.message).join(" ")} Aura will not write to a block it cannot parse; repair the markers by hand.`,
        id: `${document.sourceId}:malformed-managed-block`,
        locations: parsed.problems.map((problem) => ({
          ...(problem.line === undefined ? {} : { line: problem.line }),
          path: document.path,
        })),
        message: `The Aura-managed block in ${document.path} is malformed.`,
        metadata: {
          kind: "malformed",
          problems: parsed.problems.map((problem) => ({
            code: problem.code,
            ...(problem.line === undefined ? {} : { line: problem.line }),
          })),
          sourceId: document.sourceId,
        },
      },
    ];
  }
  if (parsed.status === "absent") {
    return [];
  }

  return parsed.block.snippets
    .filter((snippet) => !snippet.hashMatches)
    .map((snippet) => ({
      details:
        "Aura will not rewrite this snippet while the edit stands. Reconcile it by hand until a client offers the Keep, Restore, or Merge choice.",
      id: `${document.sourceId}:${snippet.id}`,
      locations: [{ line: snippet.startLine, path: document.path }],
      message: `Managed snippet ${snippet.id} in ${document.path} was edited by hand.`,
      metadata: {
        kind: "hash-mismatch",
        snippetId: snippet.id,
        sourceId: document.sourceId,
      },
    }));
}
