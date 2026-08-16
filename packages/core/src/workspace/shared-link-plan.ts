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
      return planImportLine(app, model, link, status, options.sourceContent);
    }
    case "native-copy": {
      return planNativeCopy(app, model, link, status, options.sourceContent);
    }
    case "symlink": {
      return planSymlink(app, model, link, status, options);
    }
  }
}

function planImportLine(
  app: AppModel,
  model: WorkspaceModel,
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
  return { plan: writePlan(app, link, reconciled.content, model.homeDir) };
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
  model: WorkspaceModel,
  link: ResolvedSharedLink,
  status: AdapterFileStatus | undefined,
  sourceContent: string | undefined,
): SharedInstructionLinkPlan {
  const content = sourceContent ?? instructionEntry(app, link.entryPath)?.content;
  if (status?.exists === true && sourceContent === undefined && content !== link.content) {
    return {
      blocked:
        "The Aura wrapper path contains different content, so it is treated as user-owned and preserved. Persistent keep-yours state is tracked by AURA-24.",
    };
  }
  return { plan: writePlan(app, link, link.content ?? "", model.homeDir) };
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
  return {
    plan: {
      operations: [
        {
          path: link.entryPath,
          target: options.symlinkTarget ?? model.sharedInstructions.path,
          type: "symlink",
        },
      ],
      summary: `Link ${app.displayName} to the shared instruction source.`,
    },
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

function writePlan(
  app: AppModel,
  link: ResolvedSharedLink,
  content: string,
  homeDir: string,
): FixPlan {
  return {
    ...(link.scope === "project" && content.includes(homeDir)
      ? {
          manualSteps: [
            `${link.entryPath} points at the shared source by absolute path, which is specific to this machine and this user. Keep it out of version control — add it to .gitignore or .git/info/exclude.`,
          ],
        }
      : {}),
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
