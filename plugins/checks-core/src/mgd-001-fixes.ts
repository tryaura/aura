import type {
  AuraManifest,
  AuraManifestSnippet,
  FileOperation,
  Finding,
  GuidedFixChoice,
  WorkspaceModel,
} from "@tryaura/aura-sdk";
import {
  createAuraManifestWriteOperation,
  diffManagedSnippet,
  reconcileManagedSnippet,
} from "@tryaura/core";

import { findManagedDocument, type ManagedDocument } from "./mgd-001-documents.js";

const CHECK_ID = "MGD-001";

interface MismatchContext {
  readonly document: ManagedDocument;
  readonly snippet: {
    readonly computedHash: string;
    readonly content: string;
    readonly endLine: number;
    readonly id: string;
    readonly startLine: number;
  };
}

export function guidedFixes(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  if (finding.checkId !== CHECK_ID) {
    return [];
  }
  const kind = finding.metadata?.["kind"];
  if (kind === "malformed") {
    return [malformedMergeChoice(finding)];
  }
  if (kind === "unterminated-fence") {
    return [unterminatedFenceChoice(finding)];
  }
  return kind === "hash-mismatch" ? mismatchChoices(finding, model) : [];
}

function mismatchChoices(finding: Finding, model: WorkspaceModel): readonly GuidedFixChoice[] {
  const context = mismatchContext(finding, model);
  if (context === undefined) {
    throw new Error(`The managed snippet for finding "${finding.id}" is no longer available.`);
  }

  const choices: GuidedFixChoice[] = [];
  const keep = keepChoice(context, model);
  choices.push(keep);
  const canonical = model.availableSnippets.find(
    (candidate) => candidate.id === context.snippet.id,
  );
  const restore = restoreChoice(context, canonical, model);
  if (restore !== undefined) {
    choices.push(restore);
  }
  choices.push(mergeChoice(context.document, context.snippet, canonical?.content));
  return Object.freeze(choices);
}

function mismatchContext(finding: Finding, model: WorkspaceModel): MismatchContext | undefined {
  const document = findingDocument(finding, model);
  const snippetId = finding.metadata?.["snippetId"];
  if (document === undefined || typeof snippetId !== "string") {
    return undefined;
  }
  if (document.parsed.status !== "present") {
    return undefined;
  }
  const snippet = document.parsed.block.snippets.find((candidate) => candidate.id === snippetId);
  return snippet === undefined ? undefined : { document, snippet };
}

function keepChoice(context: MismatchContext, model: WorkspaceModel): GuidedFixChoice {
  const { document, snippet } = context;
  const keep = reconcileManagedSnippet(document.content, snippet.id, { kind: "keep" });
  if (keep.status === "invalid") {
    throw new Error(
      `Keep yours could not reconcile ${snippet.id}: ${keep.problems.map((problem) => problem.message).join(" ")}`,
    );
  }
  const applied = operationsWithManifest({
    content: keep.content,
    hash: snippet.computedHash,
    model,
    path: document.path,
    pinned: true,
    snippetId: snippet.id,
  });
  return {
    id: "keep",
    label: "Keep yours",
    plan: {
      ...(applied.manualSteps.length === 0 ? {} : { manualSteps: [...applied.manualSteps] }),
      operations: applied.operations,
      summary: `Adopt the edited ${snippet.id} snippet.`,
    },
  };
}

function restoreChoice(
  context: MismatchContext,
  canonical: WorkspaceModel["availableSnippets"][number] | undefined,
  model: WorkspaceModel,
): GuidedFixChoice | undefined {
  if (canonical === undefined) {
    return undefined;
  }
  const restored = reconcileManagedSnippet(context.document.content, context.snippet.id, {
    content: canonical.content,
    kind: "restore",
  });
  if (restored.status === "invalid") {
    throw new Error(
      `Restore could not reconcile ${context.snippet.id}: ${restored.problems.map((problem) => problem.message).join(" ")}`,
    );
  }
  const applied = operationsWithManifest({
    content: restored.content,
    hash: canonical.hash,
    model,
    path: context.document.path,
    pinned: false,
    snippetId: context.snippet.id,
    version: canonical.version,
  });
  return {
    id: "restore",
    label: "Restore",
    plan: {
      ...(applied.manualSteps.length === 0 ? {} : { manualSteps: [...applied.manualSteps] }),
      operations: applied.operations,
      summary: `Restore ${context.snippet.id} from the registered snippet.`,
    },
  };
}

interface ManifestOperationOptions {
  readonly content: string;
  readonly hash: string;
  readonly model: WorkspaceModel;
  readonly path: string;
  readonly pinned: boolean;
  readonly snippetId: string;
  readonly version?: string | undefined;
}

/** The file write, plus whatever the manifest could not be made to say about it. */
interface AppliedOperations {
  readonly manualSteps: readonly string[];
  readonly operations: readonly FileOperation[];
}

/**
 * Pairs the instruction-file write with the manifest update that records it.
 *
 * The write can succeed where the manifest update cannot: an unreadable manifest, or an id that
 * several selections claim, leaves nothing unambiguous to edit. Applying only the file half is
 * still the right outcome — the marker hash is what stops the next run overwriting the user — but
 * it leaves the manifest disagreeing with disk, which is the drift the manifest exists to catch.
 * So the shortfall becomes a manual step rather than a silence.
 */
function operationsWithManifest(options: ManifestOperationOptions): AppliedOperations {
  const operations: FileOperation[] = [
    { content: options.content, path: options.path, type: "write" },
  ];
  if (options.model.manifest.status === "missing") {
    return {
      manualSteps: [
        `Create ${options.model.manifest.path} and record ${options.snippetId} at hash ${options.hash}; the manifest does not exist, so this fix updates only ${options.path}.`,
      ],
      operations,
    };
  }
  if (options.model.manifest.status === "read-only") {
    return {
      manualSteps: [
        `Record ${options.snippetId} at hash ${options.hash} after repairing the Aura manifest: ${options.model.manifest.problem.message}`,
      ],
      operations,
    };
  }

  const matches = options.model.manifest.value.snippets.filter(
    (snippet) => snippet.id === options.snippetId,
  );
  const selected = matches[0];
  if (matches.length !== 1 || selected === undefined) {
    return {
      manualSteps: [
        `Record ${options.snippetId} at hash ${options.hash} in ${options.model.manifest.path} by hand; ${String(matches.length)} manifest entries claim that id, so this fix updates only ${options.path}.`,
      ],
      operations,
    };
  }

  const manifest: AuraManifest = {
    ...options.model.manifest.value,
    snippets: options.model.manifest.value.snippets.map((snippet) =>
      snippet === selected ? updatedSelection(snippet, options) : snippet,
    ),
  };
  operations.push(createAuraManifestWriteOperation(options.model.manifest, manifest));
  return { manualSteps: [], operations };
}

function updatedSelection(
  snippet: AuraManifestSnippet,
  options: ManifestOperationOptions,
): AuraManifestSnippet {
  return {
    ...snippet,
    hash: options.hash,
    pinned: options.pinned,
    version: options.version ?? snippet.version,
  };
}

function mergeChoice(
  document: ManagedDocument,
  snippet: MismatchContext["snippet"],
  canonicalContent: string | undefined,
): GuidedFixChoice {
  const lines = `${String(snippet.startLine)}-${String(snippet.endLine)}`;
  return {
    // Built on demand: the diff quotes both the user's edit and the registered content, and a
    // choice list is exactly the shape something eventually serializes wholesale.
    ...(canonicalContent === undefined
      ? {}
      : { details: () => diffManagedSnippet(document.path, snippet.content, canonicalContent) }),
    id: "merge",
    label: "Merge",
    plan: {
      manualSteps: [
        canonicalContent === undefined
          ? `Edit ${document.path} at lines ${lines}; the registry no longer provides ${snippet.id}, so no canonical diff is available.`
          : `Review the diff and edit ${document.path} at lines ${lines} to the combined content you want.`,
        "Run `aura check` again and choose Keep yours to adopt the result.",
      ],
      operations: [],
      summary: `Manually merge the edited ${snippet.id} snippet.`,
    },
  };
}

function malformedMergeChoice(finding: Finding): GuidedFixChoice {
  const path = finding.locations?.[0]?.path;
  return {
    id: "merge",
    label: "Repair manually",
    plan: {
      manualSteps: [
        path === undefined
          ? "Repair the malformed Aura marker structure without changing surrounding content."
          : `Repair the malformed Aura marker structure in ${path} without changing surrounding content.`,
        "Run `aura check` again after the block parses cleanly.",
      ],
      operations: [],
      summary: "Repair the malformed Aura-managed block manually.",
    },
  };
}

function unterminatedFenceChoice(finding: Finding): GuidedFixChoice {
  const path = finding.locations?.[0]?.path;
  return {
    id: "close-fence",
    label: "Close the fence",
    plan: {
      manualSteps: [
        path === undefined
          ? "Close the Markdown fence that hides the Aura-managed markers."
          : `Close the Markdown fence that hides the Aura-managed markers in ${path}.`,
        "Run `aura check` again after the markers are visible.",
      ],
      operations: [],
      summary: "Close the unterminated Markdown fence manually.",
    },
  };
}

function findingDocument(finding: Finding, model: WorkspaceModel): ManagedDocument | undefined {
  const sourceId = finding.metadata?.["sourceId"];
  const path = finding.locations?.[0]?.path;
  return typeof sourceId === "string" && path !== undefined
    ? findManagedDocument(model, sourceId, path)
    : undefined;
}
