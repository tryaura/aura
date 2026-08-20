import { resolve } from "node:path";

import type {
  AdapterFileStatus,
  AppModel,
  FixPlan,
  InstructionDocument,
  ResolvedSharedLink,
  WorkspaceModel,
} from "@tryaura/aura-sdk";

import { reconcileManagedBlock } from "../managed-block/reconcile.js";

const SHARED_LINK_SNIPPET_ID = "shared-instructions";

export type SharedInstructionLinkPlan = { readonly blocked: string } | { readonly plan: FixPlan };

export interface SharedInstructionLinkPlanOptions {
  /** Declaration to materialize; defaults to the app's global shared link. */
  readonly link?: ResolvedSharedLink | undefined;
  /** Content to reconcile instead of the scanned entry, including the empty string after archival. */
  readonly sourceContent?: string | undefined;
  /**
   * Where a `symlink` declaration should point; defaults to the global shared-instruction source.
   *
   * Symlink-only on purpose. An `import-line` or `native-copy` declaration carries the reference
   * already substituted into {@link ResolvedSharedLink.content} by the scan, against the same
   * canonical target this would name, and there is no template left here to re-render. Accepting a
   * target for those kinds would be a parameter that silently does nothing.
   */
  readonly symlinkTarget?: string | undefined;
}

/** Builds the same safe shared-instruction link plan for checks and setup. */
export function planSharedInstructionLink(
  app: AppModel,
  model: WorkspaceModel,
  options: SharedInstructionLinkPlanOptions = {},
): SharedInstructionLinkPlan {
  const link = options.link ?? app.sharedLink;
  if (link === undefined) {
    return { blocked: "This adapter does not declare an automatic shared-link mechanism." };
  }

  const status = entryStatus(app, link.entryPath);
  const refusal = refuseBefore(app, status);
  if (refusal !== undefined) {
    return { blocked: refusal };
  }

  switch (link.kind) {
    case "import-line": {
      return planImportLine(app, link, status, options.sourceContent);
    }
    case "native-copy": {
      return planNativeCopy(app, link, status, options.sourceContent);
    }
    case "symlink": {
      return planSymlink(app, model, link, status, options);
    }
  }
}

function planImportLine(
  app: AppModel,
  link: ResolvedSharedLink,
  status: AdapterFileStatus | undefined,
  sourceContent: string | undefined,
): SharedInstructionLinkPlan {
  const source = instructionEntry(app, link.entryPath);
  if (unreadableInstructionEntry(status, source, sourceContent)) {
    return {
      blocked: `Something is at ${link.entryPath} that the adapter could not read as an instruction file, so Aura will not replace it. Check whether it is a broken symbolic link.`,
    };
  }
  const reconciled = reconcileManagedBlock(selectedContent(sourceContent, source), [
    { content: link.content ?? "", id: SHARED_LINK_SNIPPET_ID },
  ]);
  if (reconciled.status === "invalid") {
    return {
      blocked: `The Aura-managed block in ${link.entryPath} is malformed, so Aura will not rewrite the file. Repair or delete the block and run check --fix again.`,
    };
  }
  if (reconciled.status === "unchanged" && observedStateHolds(sourceContent)) {
    return { plan: convergedPlan(app) };
  }
  return { plan: writePlan(app, link, reconciled.content) };
}

/**
 * Whether what the scan saw still describes the file when this plan is applied.
 *
 * A caller that supplies `sourceContent` is telling us it is about to replace the entry — setup
 * passes `""` for a path it is archiving in the same plan. Reporting "already converged" from the
 * pre-archive state would drop the operation the archive needs as its replacement, and an archive
 * with no replacement removes the original outright.
 */
function observedStateHolds(sourceContent: string | undefined): boolean {
  return sourceContent === undefined;
}

function unreadableInstructionEntry(
  status: AdapterFileStatus | undefined,
  source: InstructionDocument | undefined,
  sourceContent: string | undefined,
): boolean {
  return status?.exists === true && source === undefined && sourceContent === undefined;
}

function selectedContent(
  sourceContent: string | undefined,
  source: InstructionDocument | undefined,
): string {
  return sourceContent ?? source?.content ?? "";
}

function planNativeCopy(
  app: AppModel,
  link: ResolvedSharedLink,
  status: AdapterFileStatus | undefined,
  sourceContent: string | undefined,
): SharedInstructionLinkPlan {
  const content = sourceContent ?? instructionEntry(app, link.entryPath)?.content;
  const refusal = nativeCopyRefusal(status, sourceContent, content, link.content);
  if (refusal !== undefined) {
    return { blocked: refusal };
  }
  if (status?.exists === true && content === link.content && observedStateHolds(sourceContent)) {
    return { plan: convergedPlan(app) };
  }
  return { plan: writePlan(app, link, link.content ?? "") };
}

function nativeCopyRefusal(
  status: AdapterFileStatus | undefined,
  sourceContent: string | undefined,
  content: string | undefined,
  desired: string | undefined,
): string | undefined {
  return status?.exists === true && sourceContent === undefined && content !== desired
    ? "The Aura wrapper path contains different content, so it is treated as user-owned and preserved."
    : undefined;
}

function planSymlink(
  app: AppModel,
  model: WorkspaceModel,
  link: ResolvedSharedLink,
  status: AdapterFileStatus | undefined,
  options: SharedInstructionLinkPlanOptions,
): SharedInstructionLinkPlan {
  if (
    status?.exists === true &&
    status.pathKind !== "symlink" &&
    options.sourceContent === undefined
  ) {
    return {
      blocked:
        "The existing file is user-owned. Consolidate its content before replacing it with a symlink.",
    };
  }
  const target = options.symlinkTarget ?? model.sharedInstructions.path;
  if (observedStateHolds(options.sourceContent) && pointsAt(status, target)) {
    return { plan: convergedPlan(app) };
  }
  return {
    plan: {
      operations: [
        {
          path: link.entryPath,
          target,
          type: "symlink",
        },
      ],
      summary: `Link ${app.displayName} to the shared instruction source.`,
    },
  };
}

/**
 * Whether the entry is already a symbolic link to `target`.
 *
 * Both sides are resolved, as everywhere else in this file: `symlinkTarget` is the raw `readlink`
 * result, so comparing it verbatim would re-plan an identical link whenever the same path happens
 * to be spelled differently.
 */
function pointsAt(status: AdapterFileStatus | undefined, target: string): boolean {
  if (status?.pathKind !== "symlink" || status.symlinkTarget === undefined) {
    return false;
  }
  return resolve(status.symlinkTarget) === resolve(target);
}

/** No work: the entry already loads the shared source, so the summary says so rather than promising a link. */
function convergedPlan(app: AppModel): FixPlan {
  return {
    operations: [],
    summary: `${app.displayName} already loads the shared instruction source.`,
  };
}

function refuseBefore(app: AppModel, status: AdapterFileStatus | undefined): string | undefined {
  if (app.support.status !== "supported") {
    return "Aura does not modify instruction files for an application version it cannot verify.";
  }
  if (status?.problem !== undefined) {
    return `Aura could not safely read the instruction entry (${status.problem}) and will not overwrite it.`;
  }
  return status?.pathKind === "directory"
    ? "The instruction entry is a directory and cannot be replaced automatically."
    : undefined;
}

/**
 * Writes one entry, with nothing to warn the user about afterwards.
 *
 * There used to be a manual step here telling the user to keep a project entry out of version
 * control, because a project entry could name the shared source by absolute path. It cannot any
 * more: a project entry names it relatively, and a home entry through `~`. Both are committable or
 * personal by construction rather than by advice the user has to remember to follow.
 */
function writePlan(app: AppModel, link: ResolvedSharedLink, content: string): FixPlan {
  return {
    operations: [{ content, mode: 0o644, path: link.entryPath, type: "write" }],
    summary: `Link ${app.displayName} to the shared instruction source.`,
  };
}

function instructionEntry(app: AppModel, path: string): InstructionDocument | undefined {
  return app.instructionFiles.find((document) => resolve(document.path) === resolve(path));
}

function entryStatus(app: AppModel, path: string): AdapterFileStatus | undefined {
  return app.sourceFiles.find((file) => resolve(file.spec.path) === resolve(path));
}
